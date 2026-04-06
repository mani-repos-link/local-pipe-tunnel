import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

import { getDashboardAsset, getDashboardDocument } from "./dashboard.js";
import { sanitizeHost } from "./store.js";
import { verifyAdminCredentials } from "./security.js";

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const BASE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
};

const ADMIN_CACHE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
];

function makeAdminHeaders({ html = false, cacheControl } = {}) {
  return {
    ...BASE_SECURITY_HEADERS,
    ...(cacheControl ? { "cache-control": cacheControl } : ADMIN_CACHE_HEADERS),
    ...(html ? { "content-security-policy": DASHBOARD_CSP } : {}),
  };
}

function withDefaultHeaders(headers = {}) {
  return {
    ...BASE_SECURITY_HEADERS,
    ...headers,
  };
}

function json(res, statusCode, payload, headers = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...withDefaultHeaders(headers),
  });
  res.end(body);
}

function text(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...withDefaultHeaders(headers),
  });
  res.end(body);
}

function html(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...withDefaultHeaders(headers),
  });
  res.end(body);
}

function content(res, statusCode, body, contentType, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...withDefaultHeaders(headers),
  });
  res.end(body);
}

function getOriginalProtocol(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  if (Array.isArray(forwarded)) {
    return forwarded[0];
  }

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.encrypted ? "https" : "http";
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (Array.isArray(forwarded)) {
    return forwarded[0].split(",")[0].trim();
  }

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "";
}

function challenge(res, requestId) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="local-pipe"',
    "content-type": "application/json; charset=utf-8",
    ...makeAdminHeaders(),
    "x-request-id": requestId,
  });
  res.end(JSON.stringify({ error: "Authentication required." }));
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");

    if (separator === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function requestIdFromHeader(header) {
  if (Array.isArray(header)) {
    return requestIdFromHeader(header[0]);
  }

  if (typeof header === "string" && header.trim()) {
    return header.split(",")[0].trim().slice(0, 128);
  }

  return randomUUID();
}

function createRequestContext(req, res, logger, options = {}) {
  const requestId = requestIdFromHeader(req.headers["x-request-id"]);
  const startedAt = process.hrtime.bigint();
  const context = {
    requestId,
    startedAt,
    host: sanitizeHost(req.headers.host),
    path: req.url || "/",
    clientIp: getClientIp(req),
    type: "proxy",
    routeId: null,
    target: null,
    limited: false,
    unauthorized: false,
    outcome: "finish",
  };

  res.setHeader("x-request-id", requestId);

  let logged = false;
  const skipLogging =
    options.logHealthchecks === false && context.path === "/healthz";

  const logRequest = () => {
    if (skipLogging) {
      return;
    }

    if (logged) {
      return;
    }

    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info?.("request completed", {
      requestId,
      method: req.method,
      host: context.host,
      path: context.path,
      clientIp: context.clientIp,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      type: context.type,
      routeId: context.routeId || undefined,
      target: context.target || undefined,
      limited: context.limited || undefined,
      unauthorized: context.unauthorized || undefined,
      outcome: context.outcome,
    });
  };

  res.on("finish", logRequest);
  res.on("close", () => {
    if (!res.writableEnded) {
      context.outcome = "aborted";
      logRequest();
    }
  });

  return context;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > limit) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function parseRequestBody(req) {
  const body = await readBody(req);

  if (!body) {
    return {};
  }

  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return JSON.parse(body);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }

  throw new Error("Unsupported content type.");
}

function buildProxyHeaders(req, upstreamUrl, route, requestContext, { preserveUpgrade = false } = {}) {
  const headers = { ...req.headers };
  const incomingForwardedFor = headers["x-forwarded-for"];

  for (const header of HOP_BY_HOP_HEADERS) {
    if (preserveUpgrade && (header === "connection" || header === "upgrade")) {
      continue;
    }

    delete headers[header];
  }

  if (!preserveUpgrade) {
    delete headers.upgrade;
  }

  delete headers["content-length"];
  headers.host = upstreamUrl.host;
  headers["x-forwarded-host"] = sanitizeHost(req.headers.host);
  headers["x-forwarded-proto"] = getOriginalProtocol(req);
  headers["x-forwarded-for"] = incomingForwardedFor
    ? `${incomingForwardedFor}, ${req.socket.remoteAddress || ""}`.replace(/,\s*$/, "")
    : req.socket.remoteAddress || "";
  headers["x-local-pipe-host"] = route.host;
  headers["x-request-id"] = requestContext.requestId;

  return headers;
}

function combinePaths(basePath, requestPath) {
  const cleanBase = basePath && basePath !== "/" ? basePath.replace(/\/$/, "") : "";
  const cleanRequest = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${cleanBase}${cleanRequest}` || "/";
}

function buildUpstreamTarget(route, req, hostGatewayAddress) {
  const requestUrl = new URL(req.url || "/", "http://local-pipe.internal");
  const upstream = new URL(route.target);
  upstream.pathname = combinePaths(upstream.pathname, requestUrl.pathname);
  upstream.search = requestUrl.search;
  const connectHostname =
    upstream.hostname === "host.docker.internal" && hostGatewayAddress
      ? hostGatewayAddress
      : upstream.hostname;

  return { upstreamUrl: upstream, connectHostname };
}

function attachProxyError(proxyReq, res, requestContext) {
  proxyReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    json(res, 502, {
      error: "Upstream request failed.",
      details: error.message,
      requestId: requestContext.requestId,
    });
  });
}

async function proxyHttpRequest(req, res, route, requestContext, hostGatewayAddress) {
  const { upstreamUrl, connectHostname } = buildUpstreamTarget(
    route,
    req,
    hostGatewayAddress,
  );
  const client = upstreamUrl.protocol === "https:" ? https : http;

  const proxyReq = client.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: connectHostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: buildProxyHeaders(req, upstreamUrl, route, requestContext),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        ...proxyRes.headers,
        "x-request-id": requestContext.requestId,
      });
      proxyRes.pipe(res);
    },
  );

  proxyReq.setTimeout(30_000, () => {
    proxyReq.destroy(new Error("Upstream request timed out."));
  });

  attachProxyError(proxyReq, res, requestContext);
  req.pipe(proxyReq);
}

function proxyWebSocket(
  req,
  socket,
  head,
  route,
  requestContext,
  logger,
  hostGatewayAddress,
) {
  const { upstreamUrl, connectHostname } = buildUpstreamTarget(
    route,
    req,
    hostGatewayAddress,
  );
  const targetPort =
    Number(upstreamUrl.port) || (upstreamUrl.protocol === "https:" ? 443 : 80);
  const secure = upstreamUrl.protocol === "https:";
  const upstreamSocket = secure
    ? tls.connect({
        host: connectHostname,
        port: targetPort,
        servername: upstreamUrl.hostname,
      })
    : net.connect(targetPort, connectHostname);

  upstreamSocket.on(secure ? "secureConnect" : "connect", () => {
    const headers = buildProxyHeaders(req, upstreamUrl, route, requestContext, {
      preserveUpgrade: true,
    });
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");

    upstreamSocket.write(
      `${req.method} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/${req.httpVersion}\r\n${headerLines}\r\n\r\n`,
    );

    if (head.length) {
      upstreamSocket.write(head);
    }

    socket.pipe(upstreamSocket).pipe(socket);
  });

  const closeWithError = () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
    logger.warn?.("websocket proxy failed", {
      requestId: requestContext.requestId,
      host: route.host,
      target: route.target,
    });
  };

  upstreamSocket.on("error", closeWithError);
  socket.on("error", () => upstreamSocket.destroy());
}

function routeNotFound(res, host, requestContext) {
  json(res, 404, {
    error: "Route not found.",
    host,
    requestId: requestContext?.requestId,
  });
}

export function createLocalPipeApp({
  store,
  adminHost,
  adminUsername,
  adminPassword,
  configPath,
  logger = console,
  auth,
  adminRateLimit = { windowMs: 60_000, max: 60 },
  sshDefaults = {
    sshTarget: "",
    remoteBindHost: "",
    localHost: "127.0.0.1",
  },
  hostGatewayAddress = "",
  logHealthchecks = false,
}) {
  const authConfig = auth || {
    enabled: Boolean(adminUsername || adminPassword),
    username: adminUsername,
    password: adminPassword,
    passwordHash: "",
  };
  const authEnabled = Boolean(authConfig.enabled);
  const rateState = new Map();

  function applyAdminRateLimit(req, res, requestContext) {
    const max = Number(adminRateLimit.max || 0);
    const windowMs = Number(adminRateLimit.windowMs || 0);

    if (max <= 0 || windowMs <= 0) {
      return true;
    }

    const now = Date.now();
    const key = requestContext.clientIp || "unknown";
    const entry = rateState.get(key);

    if (!entry || entry.resetAt <= now) {
      rateState.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("x-ratelimit-limit", String(max));
      res.setHeader("x-ratelimit-remaining", String(Math.max(max - 1, 0)));
      return true;
    }

    if (entry.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000),
      );
      requestContext.limited = true;
      res.setHeader("retry-after", String(retryAfterSeconds));
      res.setHeader("x-ratelimit-limit", String(max));
      res.setHeader("x-ratelimit-remaining", "0");
      json(
        res,
        429,
        {
          error: "Rate limit exceeded.",
          requestId: requestContext.requestId,
        },
        makeAdminHeaders(),
      );
      return false;
    }

    entry.count += 1;
    res.setHeader("x-ratelimit-limit", String(max));
    res.setHeader("x-ratelimit-remaining", String(Math.max(max - entry.count, 0)));
    return true;
  }

  function requireAdminAuth(req, res, requestContext) {
    if (!authEnabled) {
      return true;
    }

    const creds = parseBasicAuth(req);

    if (verifyAdminCredentials(creds, authConfig)) {
      return true;
    }

    requestContext.unauthorized = true;
    challenge(res, requestContext.requestId);
    return false;
  }

  async function handleAdmin(req, res, requestContext) {
    requestContext.type = "admin";
    const requestUrl = new URL(req.url || "/", "http://local-pipe.internal");

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      json(res, 200, { ok: true, requestId: requestContext.requestId }, makeAdminHeaders());
      return;
    }

    if (!applyAdminRateLimit(req, res, requestContext)) {
      logger.warn?.("admin rate limit exceeded", {
        requestId: requestContext.requestId,
        clientIp: requestContext.clientIp,
        path: requestUrl.pathname,
      });
      return;
    }

    if (!requireAdminAuth(req, res, requestContext)) {
      logger.warn?.("admin authentication failed", {
        requestId: requestContext.requestId,
        clientIp: requestContext.clientIp,
        path: requestUrl.pathname,
      });
      return;
    }

    try {
      if (req.method === "GET" && requestUrl.pathname === "/") {
        const dashboard = await getDashboardDocument();
        html(
          res,
          200,
          dashboard.body,
          makeAdminHeaders({
            html: true,
            cacheControl: dashboard.cacheControl,
          }),
        );
        return;
      }

      if (req.method === "GET") {
        const asset = await getDashboardAsset(requestUrl.pathname);

        if (asset) {
          content(
            res,
            200,
            asset.body,
            asset.contentType,
            makeAdminHeaders({ cacheControl: asset.cacheControl }),
          );
          return;
        }
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/state") {
        json(
          res,
          200,
          {
            adminHost,
            configPath,
            authEnabled,
            sshDefaults,
            routes: store.getState().routes,
            requestId: requestContext.requestId,
          },
          makeAdminHeaders(),
        );
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/routes") {
        const body = await parseRequestBody(req);
        const state = await store.upsertRoute(body);
        json(res, 200, { ...state, requestId: requestContext.requestId }, makeAdminHeaders());
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/reload") {
        const state = await store.reload();
        json(res, 200, { ...state, requestId: requestContext.requestId }, makeAdminHeaders());
        return;
      }

      const toggleMatch = requestUrl.pathname.match(/^\/api\/routes\/([^/]+)\/toggle$/);

      if (req.method === "POST" && toggleMatch) {
        const state = await store.toggleRoute(toggleMatch[1]);
        json(res, 200, { ...state, requestId: requestContext.requestId }, makeAdminHeaders());
        return;
      }

      const deleteMatch = requestUrl.pathname.match(/^\/api\/routes\/([^/]+)$/);

      if (req.method === "DELETE" && deleteMatch) {
        const state = await store.deleteRoute(deleteMatch[1]);
        json(res, 200, { ...state, requestId: requestContext.requestId }, makeAdminHeaders());
        return;
      }

      json(
        res,
        404,
        { error: "Admin endpoint not found.", requestId: requestContext.requestId },
        makeAdminHeaders(),
      );
    } catch (error) {
      logger.error?.("admin request failed", {
        requestId: requestContext.requestId,
        path: requestUrl.pathname,
        error: error instanceof Error ? error.message : "Request failed.",
      });
      json(
        res,
        400,
        {
          error: error instanceof Error ? error.message : "Request failed.",
          requestId: requestContext.requestId,
        },
        makeAdminHeaders(),
      );
    }
  }

  async function handleProxy(req, res, host, requestContext) {
    const route = store.findRouteByHost(host);

    if (!route || !route.enabled) {
      routeNotFound(res, host, requestContext);
      return;
    }

    requestContext.routeId = route.id;
    requestContext.target = route.target;
    await proxyHttpRequest(
      req,
      res,
      route,
      requestContext,
      hostGatewayAddress,
    );
  }

  async function requestListener(req, res) {
    const requestContext = createRequestContext(req, res, logger, {
      logHealthchecks,
    });
    const requestUrl = new URL(req.url || "/", "http://local-pipe.internal");
    const host = requestContext.host;

    if (!host) {
      json(res, 400, {
        error: "Host header is required.",
        requestId: requestContext.requestId,
      });
      return;
    }

    if (host === adminHost) {
      await handleAdmin(req, res, requestContext);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      text(res, 200, "ok\n");
      return;
    }

    await handleProxy(req, res, host, requestContext);
  }

  function upgradeListener(req, socket, head) {
    const requestId = requestIdFromHeader(req.headers["x-request-id"]);
    const host = sanitizeHost(req.headers.host);

    if (!host || host === adminHost) {
      logger.warn?.("websocket upgrade rejected", {
        requestId,
        host: host || "missing",
        reason: "invalid-host",
      });
      socket.destroy();
      return;
    }

    const route = store.findRouteByHost(host);

    if (!route || !route.enabled) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      logger.warn?.("websocket route not found", {
        requestId,
        host,
      });
      return;
    }

    logger.info?.("websocket upgrade started", {
      requestId,
      host,
      routeId: route.id,
      target: route.target,
    });
    proxyWebSocket(
      req,
      socket,
      head,
      route,
      { requestId },
      logger,
      hostGatewayAddress,
    );
  }

  return { requestListener, upgradeListener };
}
