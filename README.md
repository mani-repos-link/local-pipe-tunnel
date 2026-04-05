# local-pipe

`local-pipe` is a small host-based reverse proxy with a lightweight dashboard. It is designed to sit behind an existing Traefik instance, keep its route table in a JSON file, and forward matched hosts to SSH reverse-forward targets such as `http://host.docker.internal:41001`.

The intended flow is:

`Webhook/API -> Traefik -> local-pipe -> SSH reverse forward on VPS -> localhost on your machine`

Example:

1. Your local app listens on `127.0.0.1:3000`
2. You open an SSH reverse tunnel to the VPS
3. `local-pipe` proxies `stripe.local-pipe.example.com` to the reverse-forward target on the VPS
4. The request comes back to your machine over SSH

## DNS and TLS rules for the manual-host plan

In this plan, you do not need a new `dns-01` resolver at all. You can keep the existing Traefik `httpChallenge` setup exactly as it is, and you do not need DNS API credentials for any DNS provider. You add the subdomains manually in your DNS provider panel.

The DNS shape should be:

- `A local-pipe.example.com -> <your VPS IP>`
- `CNAME stripe.local-pipe.example.com -> local-pipe.example.com`
- `CNAME github.local-pipe.example.com -> local-pipe.example.com`

Or instead of `CNAME`, you can make each subdomain its own `A` record to the VPS IP.

Important Traefik detail: for automatic cert issuance with the current resolver, Traefik derives domains from exact `Host()` matchers, not from `HostRegexp()`. For this manual explicit-host approach, each tunnel hostname should be declared explicitly in labels or dynamic config.

The working setup is:

- DNS: manually add `stripe.local-pipe.example.com`
- Traefik: add a router with `Host(\`stripe.local-pipe.example.com\`)`
- `local-pipe`: map that host to the SSH reverse-forward target in `routes.json`

## Features

- JSON-backed route table
- Dashboard to add, update, enable, disable, and delete routes
- Dashboard SSH command generator per route
- Reload config from disk without restarting the container
- Reverse proxy by exact host match
- HTTP and WebSocket upgrade proxying
- Optional admin auth with plain password or `scrypt` hash
- In-memory rate limiting for the admin surface
- Structured JSON request logs with request IDs
- Target-host allowlist support for production hardening
- No local client or agent required

## Route model

Routes are stored in `data/routes.json`:

```json
{
  "routes": [
    {
      "id": "stripe-example",
      "host": "stripe.local-pipe.example.com",
      "target": "http://host.docker.internal:41001",
      "enabled": true,
      "notes": "SSH reverse forward from localhost:3000",
      "sshTarget": "tunnel@example-vps",
      "localHost": "127.0.0.1",
      "localPort": 3000,
      "createdAt": "2026-04-05T00:00:00.000Z",
      "updatedAt": "2026-04-05T00:00:00.000Z"
    }
  ]
}
```

Rules:

- `host` must be a valid lowercase DNS hostname
- `target` must be `http://` or `https://`
- `target` must not include embedded credentials or a query string
- if `ALLOWED_TARGET_HOSTS` is configured, the target hostname must be in that allowlist
- `sshTarget`, `remoteBindHost`, `localHost`, and `localPort` are optional, but if they are set the dashboard can generate an exact copy-paste SSH command for the route

## SSH pattern

This service is built around SSH reverse forwarding.

Quick local command:

```bash
ssh -NT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R <detected-host-gateway-ip>:41001:127.0.0.1:3000 \
  tunnel@example-vps
```

Then create this route in `local-pipe`:

- Host: `stripe.local-pipe.example.com`
- Target: `http://host.docker.internal:41001`
- SSH destination: `tunnel@example-vps`
- Local port: `3000`

### How the remote bind host is determined

`local-pipe` does not need to assume `172.17.0.1`. At startup it tries to resolve `host.docker.internal` from inside the container and uses that resolved IP as the default remote bind host for generated SSH commands.

That is the safest default for this setup because:

- the container already reaches the VPS host through `host.docker.internal`
- Docker maps that hostname to the host gateway when `extra_hosts: host.docker.internal:host-gateway` is present
- the generated SSH command then binds specifically to the address the container can reach

If auto-detection fails, set `DEFAULT_REMOTE_BIND_HOST` explicitly in `.env`.

If you want to verify what the container sees, check it inside the running container:

```bash
getent hosts host.docker.internal
```

The dashboard shows the detected value in the header and uses it in the copy button for each route.

### SSH server requirements on the VPS

Because the command binds the reverse-forward on a specific VPS-side address, your SSH server usually needs these settings in `sshd_config`:

- `AllowTcpForwarding yes`
- `GatewayPorts clientspecified`

If the SSH server is locked down, the tunnel command may connect successfully but the remote bind can still fail.

## Admin auth and password hashing

The dashboard supports:

- `ADMIN_PASSWORD` for a plain-text password
- `ADMIN_PASSWORD_HASH` for a `scrypt` hash
- `ADMIN_PASSWORD_FILE` or `ADMIN_PASSWORD_HASH_FILE` for Docker secrets or mounted files

Hash generation:

```bash
npm run hash-password -- 'replace-this-with-a-strong-password'
```

Then place the output in `.env`:

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$...
```

If both `ADMIN_PASSWORD` and `ADMIN_PASSWORD_HASH` are set, startup fails. If auth is disabled entirely, the service logs a warning.

## Environment variables

- `PORT`: listen port inside the container. Default `8080`
- `ADMIN_HOST`: dashboard host. Default `local-pipe.example.com`
- `CONFIG_PATH`: JSON config path. Default `./data/routes.json`
- `ADMIN_USERNAME`: admin username
- `ADMIN_PASSWORD`: plain admin password
- `ADMIN_PASSWORD_FILE`: file containing the plain admin password
- `ADMIN_PASSWORD_HASH`: `scrypt` password hash
- `ADMIN_PASSWORD_HASH_FILE`: file containing the password hash
- `ADMIN_RATE_LIMIT_MAX`: max admin requests per window. Default `60`
- `ADMIN_RATE_LIMIT_WINDOW_MS`: rate-limit window in milliseconds. Default `60000`
- `ALLOWED_TARGET_HOSTS`: comma-separated target hostname allowlist. Empty means unrestricted
- `MAX_ROUTES`: maximum number of routes. Default `250`
- `DEFAULT_SSH_TARGET`: default SSH destination shown in the dashboard form
- `DEFAULT_REMOTE_BIND_HOST`: optional override for the VPS-side bind host. If empty, local-pipe tries to resolve `host.docker.internal`
- `DEFAULT_LOCAL_HOST`: default local host for generated commands. Default `127.0.0.1`

## Local run

```bash
cp data/routes.example.json data/routes.json
ADMIN_HOST=local-pipe.example.com \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=replace-this \
node src/server.js
```

Test locally with curl:

```bash
curl -u admin:replace-this \
  -H 'Host: local-pipe.example.com' \
  http://127.0.0.1:8080/api/state
```

## Docker deployment

The main deploy file is [compose.yml](/Users/manpreet/Documents/project/startup/local-pipe/compose.yml).

Production defaults in the compose file:

- `init: true`
- `cap_drop: [ALL]`
- `security_opt: no-new-privileges:true`
- Docker healthcheck against `/healthz`
- explicit Traefik `Host()` routers
- `ALLOWED_TARGET_HOSTS=host.docker.internal,127.0.0.1,localhost`
- optional defaults for SSH command generation via `DEFAULT_SSH_TARGET`, `DEFAULT_REMOTE_BIND_HOST`, and `DEFAULT_LOCAL_HOST`

If you need to target a different upstream host, add it to `ALLOWED_TARGET_HOSTS` or leave the variable empty.

## Copy-paste setup

### 1. On the VPS

```bash
cp .env.example .env
cp data/routes.example.json data/routes.json
npm run hash-password -- 'replace-this-with-a-strong-password'
```

Put the generated hash into `.env`, then start the service:

```bash
docker compose up -d --build
```

### 2. In DNS

Create:

- `A local-pipe.example.com -> <your VPS IP>`
- `CNAME stripe.local-pipe.example.com -> local-pipe.example.com`

### 3. In Traefik labels

The root compose already includes two routers:

- `local-pipe.example.com` for the dashboard
- `stripe.local-pipe.example.com` for one tunnel

For a second tunnel such as `github.local-pipe.example.com`, duplicate the `local-pipe-stripe` router labels and change only the router name and host rule:

```yaml
traefik.http.routers.local-pipe-github.rule: "Host(`github.local-pipe.example.com`)"
traefik.http.routers.local-pipe-github.entrypoints: "websecure"
traefik.http.routers.local-pipe-github.tls: "true"
traefik.http.routers.local-pipe-github.tls.certresolver: "letsencrypt"
traefik.http.routers.local-pipe-github.service: "local-pipe"
```

Then redeploy:

```bash
docker compose up -d
```

### 4. On your local machine

Run the SSH reverse tunnel:

```bash
ssh -NT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R <detected-host-gateway-ip>:41001:127.0.0.1:3000 \
  tunnel@example-vps
```

This means:

- public host: `stripe.local-pipe.example.com`
- VPS-side forwarded port: `41001`
- local app: `127.0.0.1:3000`

### 5. In the dashboard

Create or update the route:

- Host: `stripe.local-pipe.example.com`
- Target: `http://host.docker.internal:41001`
- SSH destination: `tunnel@example-vps`
- Remote bind host: use the detected value shown in the dashboard, or set `DEFAULT_REMOTE_BIND_HOST`
- Local host: `127.0.0.1`
- Local port: `3000`
- Enabled: `true`

At that point, requests hitting `https://stripe.local-pipe.example.com` should reach your local app on port `3000`.

You can then use the dashboard row button to copy the raw `ssh` command.

## Logging and hardening notes

- Every response gets an `x-request-id`
- Admin responses send no-store cache headers
- The dashboard sends a restrictive CSP
- Admin requests are rate-limited in memory by client IP
- Logs are JSON lines written to stdout or stderr

Example log line:

```json
{
  "ts": "2026-04-05T22:00:00.000Z",
  "level": "info",
  "msg": "request completed",
  "service": "local-pipe",
  "requestId": "4ff2c9c8-7f4b-4af9-a5f7-8197fd2e4f1d",
  "method": "GET",
  "host": "stripe.local-pipe.example.com",
  "path": "/webhook",
  "statusCode": 200,
  "durationMs": 12.5,
  "type": "proxy"
}
```

## Current limits

- No built-in TLS. TLS termination stays in Traefik.
- SSH tunnel lifecycle is still manual.
- Rate limiting is in-memory only.
- No request history yet.
- No multi-user auth yet.
- Hostnames are exact-match only in the app, by design.

## Test

```bash
npm test
```
