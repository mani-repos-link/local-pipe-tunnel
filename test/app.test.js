import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import test from "node:test";

import { createLocalPipeApp } from "../src/app.js";
import { createPasswordHash } from "../src/security.js";
import { RouteStore } from "../src/store.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function makeRequest(port, { host, pathName = "/", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          host,
          ...headers,
        },
      },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) {
          chunks.push(chunk);
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      },
    );

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

test("store persists routes to disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-pipe-"));
  const filePath = path.join(dir, "routes.json");
  const store = new RouteStore(filePath);

  await store.load();
  await store.upsertRoute({
    host: "stripe.local-pipe.example.com",
    target: "host.docker.internal:41001",
    notes: "test route",
    sshTarget: "tunnel@example-vps",
    remoteBindHost: "172.17.0.1",
    localHost: "127.0.0.1",
    localPort: 3000,
    enabled: true,
  });

  const raw = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(raw.routes.length, 1);
  assert.equal(raw.routes[0].host, "stripe.local-pipe.example.com");
  assert.equal(raw.routes[0].target, "http://host.docker.internal:41001");
  assert.equal(raw.routes[0].sshTarget, "tunnel@example-vps");
  assert.equal(raw.routes[0].remoteBindHost, "172.17.0.1");
  assert.equal(raw.routes[0].localHost, "127.0.0.1");
  assert.equal(raw.routes[0].localPort, 3000);
});

test("store rejects invalid hosts and disallowed target hosts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-pipe-"));
  const filePath = path.join(dir, "routes.json");
  const store = new RouteStore(filePath, {
    allowedTargetHosts: ["host.docker.internal"],
  });

  await store.load();

  await assert.rejects(
    store.upsertRoute({
      host: "bad_host",
      target: "http://host.docker.internal:41001",
    }),
    /valid lowercase DNS name/,
  );

  await assert.rejects(
    store.upsertRoute({
      host: "stripe.local-pipe.example.com",
      target: "http://127.0.0.1:41001",
    }),
    /ALLOWED_TARGET_HOSTS/,
  );
});

test("app serves dashboard and proxies tunnel routes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-pipe-"));
  const filePath = path.join(dir, "routes.json");
  const store = new RouteStore(filePath);
  await store.load();

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        forwardedHost: req.headers["x-forwarded-host"],
      }),
    );
  });

  const upstreamPort = await listen(upstream);

  await store.upsertRoute({
    host: "stripe.local-pipe.example.com",
    target: `http://127.0.0.1:${upstreamPort}`,
    enabled: true,
  });

  const app = createLocalPipeApp({
    store,
    adminHost: "local-pipe.example.com",
    configPath: filePath,
    sshDefaults: {
      sshTarget: "default@example-vps",
      remoteBindHost: "172.17.0.1",
      localHost: "127.0.0.1",
    },
    logger: silentLogger,
  });
  const server = http.createServer(app.requestListener);
  const port = await listen(server);

  const dashboardResponse = await makeRequest(port, {
    host: "local-pipe.example.com",
    pathName: "/api/state",
  });
  assert.equal(dashboardResponse.statusCode, 200);
  assert.match(dashboardResponse.body, /stripe\.local-pipe\.example\.com/);
  assert.match(dashboardResponse.body, /default@example-vps/);

  const proxyResponse = await makeRequest(port, {
    host: "stripe.local-pipe.example.com",
    pathName: "/webhook?hello=1",
  });

  assert.equal(proxyResponse.statusCode, 200);
  const payload = JSON.parse(proxyResponse.body);
  assert.equal(payload.url, "/webhook?hello=1");
  assert.equal(payload.forwardedHost, "stripe.local-pipe.example.com");
  assert.ok(proxyResponse.headers["x-request-id"]);

  await close(server);
  await close(upstream);
});

test("admin endpoints accept scrypt-hashed passwords", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-pipe-"));
  const filePath = path.join(dir, "routes.json");
  const store = new RouteStore(filePath);
  await store.load();

  const app = createLocalPipeApp({
    store,
    adminHost: "local-pipe.example.com",
    configPath: filePath,
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: createPasswordHash("secret-password"),
    },
    logger: silentLogger,
  });

  const server = http.createServer(app.requestListener);
  const port = await listen(server);

  const unauthorized = await makeRequest(port, {
    host: "local-pipe.example.com",
    pathName: "/api/state",
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await makeRequest(port, {
    host: "local-pipe.example.com",
    pathName: "/api/state",
    headers: {
      authorization: `Basic ${Buffer.from("admin:secret-password").toString("base64")}`,
    },
  });

  assert.equal(authorized.statusCode, 200);
  assert.ok(authorized.headers["x-request-id"]);

  await close(server);
});

test("admin rate limiting returns 429 after the configured threshold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-pipe-"));
  const filePath = path.join(dir, "routes.json");
  const store = new RouteStore(filePath);
  await store.load();

  const app = createLocalPipeApp({
    store,
    adminHost: "local-pipe.example.com",
    configPath: filePath,
    adminRateLimit: {
      max: 1,
      windowMs: 60_000,
    },
    logger: silentLogger,
  });

  const server = http.createServer(app.requestListener);
  const port = await listen(server);

  const first = await makeRequest(port, {
    host: "local-pipe.example.com",
    pathName: "/api/state",
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-ratelimit-remaining"], "0");

  const second = await makeRequest(port, {
    host: "local-pipe.example.com",
    pathName: "/api/state",
  });

  assert.equal(second.statusCode, 429);
  assert.ok(second.headers["retry-after"]);

  await close(server);
});
