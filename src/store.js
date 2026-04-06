import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = { routes: [] };
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ROUTE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const COMMAND_TOKEN_PATTERN = /^\S{1,255}$/;

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function validateHost(host) {
  if (!host) {
    throw new Error("Host is required.");
  }

  if (!HOSTNAME_PATTERN.test(host)) {
    throw new Error("Host must be a valid lowercase DNS name.");
  }
}

function normalizeTarget(target, options = {}) {
  const value = String(target || "").trim();

  if (!value) {
    throw new Error("Target is required.");
  }

  const candidate = value.includes("://") ? value : `http://${value}`;
  const url = new URL(candidate);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Target must use http or https.");
  }

  if (url.username || url.password) {
    throw new Error("Target must not include URL credentials.");
  }

  if (url.search) {
    throw new Error("Target must not include a query string.");
  }

  url.hash = "";
  const allowedTargetHosts = options.allowedTargetHosts || null;
  const normalizedHost = url.hostname.toLowerCase();

  if (allowedTargetHosts && allowedTargetHosts.size > 0) {
    if (!allowedTargetHosts.has(normalizedHost)) {
      throw new Error(
        `Target host ${normalizedHost} is not in ALLOWED_TARGET_HOSTS.`,
      );
    }
  }

  return url.toString().replace(/\/$/, "");
}

function normalizeNotes(notes) {
  const value = String(notes || "").trim();

  if (value.length > 2_000) {
    throw new Error("Notes must be 2000 characters or fewer.");
  }

  return value;
}

function normalizeRouteId(id) {
  const value = String(id || "").trim();

  if (!value) {
    return randomUUID();
  }

  if (!ROUTE_ID_PATTERN.test(value)) {
    throw new Error("Route id contains invalid characters.");
  }

  return value;
}

function normalizeCommandToken(value, fieldName, { required = false } = {}) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    if (required) {
      throw new Error(`${fieldName} is required.`);
    }

    return "";
  }

  if (!COMMAND_TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must not contain spaces.`);
  }

  return normalized;
}

function normalizePort(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`${fieldName} is required.`);
    }

    return null;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${fieldName} must be a valid TCP port.`);
  }

  return port;
}

function normalizeTunnelFields(input, defaults = {}) {
  return {
    sshTarget: normalizeCommandToken(input?.sshTarget, "SSH target"),
    localHost: normalizeCommandToken(
      input?.localHost || defaults.localHost,
      "Local host",
    ),
    localPort: normalizePort(input?.localPort, "Local port"),
  };
}

function sortRoutes(routes) {
  return [...routes].sort((left, right) => left.host.localeCompare(right.host));
}

export class RouteStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.allowedTargetHosts = new Set(
      (options.allowedTargetHosts || []).map((host) =>
        String(host).trim().toLowerCase(),
      ),
    );
    this.maxRoutes = Number.isFinite(options.maxRoutes)
      ? Number(options.maxRoutes)
      : 250;
    this.sshDefaults = {
      remoteBindHost: normalizeCommandToken(
        options.sshDefaults?.remoteBindHost || "",
        "Default remote bind host",
      ),
      localHost: normalizeCommandToken(
        options.sshDefaults?.localHost || "127.0.0.1",
        "Default local host",
        { required: true },
      ),
      sshTarget: normalizeCommandToken(
        options.sshDefaults?.sshTarget || "",
        "Default SSH target",
      ),
    };
    this.state = structuredClone(DEFAULT_STATE);
    this.writeQueue = Promise.resolve();
  }

  async ensureFile() {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const existing = await stat(this.filePath);

      if (existing.isDirectory()) {
        throw new Error(
          `CONFIG_PATH ${this.filePath} is a directory. It must point to a JSON file. Remove the directory and restart.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && !("code" in error)) {
        throw error;
      }

      await writeFile(
        this.filePath,
        `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`,
        "utf8",
      );
    }
  }

  async load() {
    await this.ensureFile();
    const raw = await readFile(this.filePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : structuredClone(DEFAULT_STATE);

    if (!parsed || !Array.isArray(parsed.routes)) {
      throw new Error("Config file must contain a top-level routes array.");
    }

    this.state = {
      routes: sortRoutes(
        parsed.routes.map((route) => this.#normalizePersistedRoute(route)),
      ),
    };

    return this.getState();
  }

  getState() {
    return structuredClone(this.state);
  }

  findRouteByHost(host) {
    const normalizedHost = normalizeHost(host);
    return this.state.routes.find((route) => route.host === normalizedHost) || null;
  }

  async reload() {
    return this.load();
  }

  async upsertRoute(input) {
    const now = new Date().toISOString();
    const host = normalizeHost(input.host);
    const target = normalizeTarget(input.target, {
      allowedTargetHosts: this.allowedTargetHosts,
    });
    const notes = normalizeNotes(input.notes);
    const tunnel = normalizeTunnelFields(input, this.sshDefaults);
    validateHost(host);

    const id = normalizeRouteId(input.id);
    const enabled = input.enabled !== false && String(input.enabled) !== "false";
    const routes = [...this.state.routes];
    const existingIndex = routes.findIndex((route) => route.id === id);

    if (existingIndex < 0 && routes.length >= this.maxRoutes) {
      throw new Error(`Route limit reached (${this.maxRoutes}).`);
    }

    const conflictingHost = routes.find(
      (route) => route.host === host && route.id !== id,
    );

    if (conflictingHost) {
      throw new Error(`Host ${host} already exists.`);
    }

    if (existingIndex >= 0) {
      routes[existingIndex] = {
        ...routes[existingIndex],
        host,
        target,
        notes,
        ...tunnel,
        enabled,
        updatedAt: now,
      };
    } else {
      routes.push({
        id,
        host,
        target,
        notes,
        ...tunnel,
        enabled,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.state = { routes: sortRoutes(routes) };
    await this.#persist();
    return this.getState();
  }

  async toggleRoute(id) {
    const routes = [...this.state.routes];
    const index = routes.findIndex((route) => route.id === id);

    if (index < 0) {
      throw new Error("Route not found.");
    }

    routes[index] = {
      ...routes[index],
      enabled: !routes[index].enabled,
      updatedAt: new Date().toISOString(),
    };

    this.state = { routes: sortRoutes(routes) };
    await this.#persist();
    return this.getState();
  }

  async deleteRoute(id) {
    const routes = this.state.routes.filter((route) => route.id !== id);

    if (routes.length === this.state.routes.length) {
      throw new Error("Route not found.");
    }

    this.state = { routes: sortRoutes(routes) };
    await this.#persist();
    return this.getState();
  }

  #normalizePersistedRoute(route) {
    const now = new Date().toISOString();
    const host = normalizeHost(route?.host);
    validateHost(host);

    return {
      id: normalizeRouteId(route?.id),
      host,
      target: normalizeTarget(route?.target, {
        allowedTargetHosts: this.allowedTargetHosts,
      }),
      enabled: route?.enabled !== false,
      notes: normalizeNotes(route?.notes),
      ...normalizeTunnelFields(route, this.sshDefaults),
      createdAt: route?.createdAt ? String(route.createdAt) : now,
      updatedAt: route?.updatedAt ? String(route.updatedAt) : now,
    };
  }

  async #persist() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;

    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, payload, "utf8");
      await rename(tmpPath, this.filePath);
    });

    return this.writeQueue;
  }
}

export function sanitizeHost(host) {
  return normalizeHost(host);
}
