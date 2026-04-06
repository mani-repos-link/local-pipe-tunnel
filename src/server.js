import http from "node:http";
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createLocalPipeApp } from "./app.js";
import { createLogger } from "./logger.js";
import { verifyPasswordHash } from "./security.js";
import { RouteStore } from "./store.js";

const logger = createLogger({ service: "local-pipe" });

async function readSecret(name) {
  const directValue = process.env[name];
  const filePath = process.env[`${name}_FILE`];

  if (directValue && filePath) {
    throw new Error(`Set either ${name} or ${name}_FILE, not both.`);
  }

  if (filePath) {
    return (await readFile(path.resolve(filePath), "utf8")).trim();
  }

  return directValue || "";
}

function parseInteger(name, fallback) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function parseNonNegativeInteger(name, fallback) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be zero or a positive integer.`);
  }

  return value;
}

function parseCsv(name) {
  const raw = process.env[name] || "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value.`);
}

function decodeLinuxRouteHex(value) {
  if (!/^[0-9a-fA-F]{8}$/.test(value)) {
    return "";
  }

  const bytes = value.match(/../g);

  if (!bytes) {
    return "";
  }

  return bytes
    .reverse()
    .map((pair) => String(parseInt(pair, 16)))
    .join(".");
}

async function detectContainerGateway(logger) {
  try {
    const contents = await readFile("/proc/net/route", "utf8");
    const lines = contents.trim().split("\n").slice(1);

    for (const line of lines) {
      const columns = line.trim().split(/\s+/);

      if (columns.length < 3) {
        continue;
      }

      const destination = columns[1];
      const gatewayHex = columns[2];

      if (destination !== "00000000") {
        continue;
      }

      const gateway = decodeLinuxRouteHex(gatewayHex);

      if (gateway) {
        logger.info("detected container network gateway", {
          remoteBindHost: gateway,
        });
        return gateway;
      }
    }
  } catch (error) {
    logger.warn("failed to inspect /proc/net/route for gateway detection", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return "";
}

async function detectRemoteBindHost(logger) {
  const configured = (process.env.DEFAULT_REMOTE_BIND_HOST || "").trim();

  if (configured) {
    return configured;
  }

  const containerGateway = await detectContainerGateway(logger);

  if (containerGateway) {
    return containerGateway;
  }

  try {
    const result = await dns.lookup("host.docker.internal", { family: 4 });
    logger.info("detected remote bind host from host.docker.internal fallback", {
      remoteBindHost: result.address,
    });
    return result.address;
  } catch (error) {
    logger.warn("failed to auto-detect remote bind host", {
      recommendation:
        "Set DEFAULT_REMOTE_BIND_HOST explicitly if SSH command generation should include a bind address.",
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

async function main() {
  const port = parseInteger("PORT", 8030);
  const adminHost = (process.env.ADMIN_HOST || "local-pipe.example.com")
    .trim()
    .toLowerCase();
  const configPath = path.resolve(process.env.CONFIG_PATH || "./data/routes.json");
  const adminUsername = (await readSecret("ADMIN_USERNAME")).trim();
  const adminPassword = await readSecret("ADMIN_PASSWORD");
  const allowedTargetHosts = parseCsv("ALLOWED_TARGET_HOSTS");
  const maxRoutes = parseInteger("MAX_ROUTES", 250);
  const detectedRemoteBindHost = await detectRemoteBindHost(logger);
  const logHealthchecks = parseBoolean("LOG_HEALTHCHECKS", false);
  const sshDefaults = {
    sshTarget: (process.env.DEFAULT_SSH_TARGET || "").trim(),
    remoteBindHost: detectedRemoteBindHost,
    localHost: (process.env.DEFAULT_LOCAL_HOST || "127.0.0.1").trim(),
  };
  const adminRateLimitWindowMs = parseNonNegativeInteger(
    "ADMIN_RATE_LIMIT_WINDOW_MS",
    60_000,
  );
  const adminRateLimitMax = parseNonNegativeInteger("ADMIN_RATE_LIMIT_MAX", 60);

  if (adminUsername && !adminPassword) {
    throw new Error("ADMIN_USERNAME requires ADMIN_PASSWORD.");
  }

  if (!adminUsername && adminPassword) {
    throw new Error("ADMIN_USERNAME is required when admin auth is enabled.");
  }

  const auth = {
    enabled: Boolean(adminUsername),
    username: adminUsername,
    password: adminPassword,
  };

  const store = new RouteStore(configPath, {
    allowedTargetHosts,
    maxRoutes,
    sshDefaults,
  });
  await store.load();

  if (!auth.enabled) {
    logger.warn("admin authentication is disabled", { adminHost });
  }

  const app = createLocalPipeApp({
    store,
    adminHost,
    auth,
    configPath,
    adminRateLimit: {
      windowMs: adminRateLimitWindowMs,
      max: adminRateLimitMax,
    },
    sshDefaults,
    hostGatewayAddress: detectedRemoteBindHost,
    logHealthchecks,
    logger,
  });

  const server = http.createServer(app.requestListener);
  server.on("upgrade", app.upgradeListener);
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  server.listen(port, "0.0.0.0", () => {
    logger.info("server started", {
      port,
      adminHost,
      configPath,
      authEnabled: auth.enabled,
      passwordHashEnabled: Boolean(adminPasswordHash),
      adminRateLimitMax,
      adminRateLimitWindowMs,
      allowedTargetHosts,
      maxRoutes,
      sshDefaults,
      logHealthchecks,
    });
  });

  const shutdown = (signal) => {
    logger.info("shutdown requested", { signal });
    server.close((error) => {
      if (error) {
        logger.error("shutdown failed", { signal, error: error.message });
        process.exit(1);
      }

      logger.info("server stopped", { signal });
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("forced shutdown", { signal });
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("startup failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
