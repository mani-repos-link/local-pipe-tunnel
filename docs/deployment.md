# Deployment Notes

## Manual Host Plan

This project assumes:

- Traefik already handles TLS and public entry
- each tunnel host is added manually in DNS
- each tunnel host has an explicit Traefik `Host()` router

For this setup, you do not need a wildcard `dns-01` resolver. If you already use wildcard DNS and wildcard certificates in your own infrastructure, you can automate more of this, but the default pattern here assumes explicit hosts.

Example DNS:

- `A local-pipe.example.com -> <your VPS IP>`
- `CNAME stripe.local-pipe.example.com -> local-pipe.example.com`
- `CNAME github.local-pipe.example.com -> local-pipe.example.com`

Instead of `CNAME`, each subdomain can also be its own `A` record to the VPS IP.

Important Traefik detail: automatic cert issuance is derived from exact `Host()` rules, not `HostRegexp()`, unless you configure domains explicitly.

## Route Model

Routes are stored in `data/routes.json`.

Example:

```json
{
  "routes": [
    {
      "id": "stripe-example",
      "host": "stripe.local-pipe.example.com",
      "target": "http://127.0.0.1:41001",
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
- `target` must use `http://` or `https://`
- `target` must not include embedded credentials or a query string
- if `ALLOWED_TARGET_HOSTS` is set, the target hostname must be in that allowlist
- `sshTarget`, `localHost`, and `localPort` are optional metadata used by the dashboard SSH generator

## SSH Pattern

Example local command:

```bash
ssh -NT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:41001:127.0.0.1:3000 \
  tunnel@example-vps
```

Matching route:

- Host: `stripe.local-pipe.example.com`
- Target: `http://127.0.0.1:41001`
- Local app: `127.0.0.1:3000`

### Remote Bind Host Detection

In the recommended VPS deployment, `local-pipe` runs with Docker host networking. That keeps the SSH reverse-forward path simple:

- route target: `http://127.0.0.1:<remote-port>`
- SSH reverse bind host: `127.0.0.1`

`DEFAULT_REMOTE_BIND_HOST` is therefore set to `127.0.0.1` by default in the Compose deployment.

### SSH Server Requirements

For bind-specific reverse forwards, the VPS SSH server usually needs:

- `AllowTcpForwarding yes`
- `GatewayPorts clientspecified`

## Environment Variables

Main variables:

- `PORT`: internal listen port. Default `8030`
- `ADMIN_HOST`: dashboard host
- `ADMIN_USERNAME`: admin username
- `ADMIN_PASSWORD`: plain admin password
- `ADMIN_PASSWORD_HASH`: `scrypt` password hash
- `LOG_HEALTHCHECKS`: log `/healthz` requests or not. Default `false`
- `ALLOWED_TARGET_HOSTS`: comma-separated target host allowlist
- `DEFAULT_SSH_TARGET`: default SSH destination shown in the dashboard
- `DEFAULT_REMOTE_BIND_HOST`: VPS-side bind host for generated SSH commands. Default `127.0.0.1`
- `DEFAULT_LOCAL_HOST`: default local host for generated commands

See [`.env.example`](../.env.example) for the full list.

## Docker Deployment

The main deploy file is [`compose.yml`](../compose.yml).

Current defaults:

- host networking on the VPS
- non-root runtime user
- bind-mounted `data/` directory
- Compose-level healthcheck against `/healthz`
- explicit Traefik routers
- Traefik service URL points to `http://${TRAEFIK_BACKEND_HOST}:${PORT}` so Traefik can reach the host-networked app

First deploy:

```bash
cp .env.example .env
docker compose up -d --build
```

If `data/routes.json` does not exist, `local-pipe` creates it on first start.

If dashboard saves fail because of bind-mount permissions, either:

```bash
chown -R 10001:10001 data
```

or set `LOCAL_PIPE_UID` and `LOCAL_PIPE_GID` in `.env` to match the host file owner.

## Traefik Example

The root compose already includes:

- one dashboard router for `local-pipe.example.com`
- one explicit Traefik service URL that points to `http://${TRAEFIK_BACKEND_HOST}:${PORT}`

Additional tunnel routers belong in `.traefik/private.labels` or your own Traefik config.

### Why `server.url` is used

`local-pipe` runs with host networking so it can proxy to SSH reverse forwards on `127.0.0.1`.

In that setup, the cleanest Traefik-side approach is to use an explicit Docker label:

```yaml
traefik.http.services.local-pipe.loadbalancer.server.url: "http://${TRAEFIK_BACKEND_HOST}:8030"
```

That makes Traefik call the VPS host directly instead of relying on Docker-network IP detection for the `local-pipe` container.

The default value in [`.env.example`](../.env.example) is:

```dotenv
TRAEFIK_BACKEND_HOST=host.docker.internal
```

That works on many setups, but it is not reliable on every Linux host. On custom bridge networks, Docker may resolve `host.docker.internal` to the wrong gateway for the Traefik container.

If Traefik returns `504 Gateway Timeout` while the app itself is healthy on the VPS host, discover Traefik's actual bridge gateway and set `TRAEFIK_BACKEND_HOST` explicitly:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' traefik
```

Then put that value into `.env`, for example:

```dotenv
TRAEFIK_BACKEND_HOST=172.18.0.1
```

Redeploy after changing it:

```bash
docker compose up -d --build --force-recreate
```

Verification from the VPS:

```bash
curl -v http://127.0.0.1:8030/healthz
docker exec traefik wget -S -O- "http://${TRAEFIK_BACKEND_HOST}:8030/healthz"
```

If the first command works and the second still times out, your host firewall is likely dropping traffic from the custom Docker bridge interface. Allow the bridge interface Traefik is actually using, not just `docker0`.

To find the bridge interface for the `traefik` Docker network:

```bash
docker network inspect traefik -f '{{.Id}}'
```

Docker bridge interfaces are usually named `br-<first-12-chars-of-network-id>`.

Example firewall rules:

```bash
ufw allow in on br-xxxxxxxxxxxx to any port 8030 proto tcp
iptables -I INPUT 1 -i br-xxxxxxxxxxxx -p tcp --dport 8030 -j ACCEPT
```

## Private Traefik Routers

If you run personal or project-specific tunnel hosts, do not add those labels directly to the main `compose.yml` in the open-source repo.

Use a private override file plus a private labels file instead:

1. Copy [`.traefik/compose.private.example.yml`](../.traefik/compose.private.example.yml) to `.traefik/compose.private.yml`
2. Copy [`.traefik/private.labels.example`](../.traefik/private.labels.example) to `.traefik/private.labels`
3. Put your personal Traefik router labels in `.traefik/private.labels`
4. Keep both real files untracked

The repo already ignores that file:

```gitignore
.traefik/compose.private.yml
.traefik/private.labels
```

The private override uses Docker Compose `label_file`, so you can also add extra local-only environment variables or other service overrides in `.traefik/compose.private.yml` without touching the public `compose.yml`.

Important: `private.labels` is a label file, not YAML. Use literal hostnames there and keep every line in `key=value` form. Do not use `${...}` interpolation inside that file.

You have two clean ways to load it.

### Option 1: `COMPOSE_FILE` in `.env`

Because `.env` is already local-only, this is the simplest day-to-day setup:

```dotenv
COMPOSE_FILE=compose.yml:.traefik/compose.private.yml
```

Then your normal command keeps working:

```bash
docker compose up -d --build
```

### Option 2: explicit `-f` flags

If you prefer not to set `COMPOSE_FILE`, run:

```bash
docker compose -f compose.yml -f .traefik/compose.private.yml up -d --build
```

### Why this pattern

- it keeps private domains and router names out of git history
- it merges cleanly into the existing `local-pipe` service
- it keeps bulky private Traefik labels out of YAML
- it uses standard Docker Compose file merging
- it lets the same `.env` values apply to both Compose files
- it avoids trying to use YAML anchors across files, which do not work the way Compose merge files do

For this use case, a merge override is the clean solution. A nested file “called” from `compose.yml` is not the right Compose mechanism for extending the same service definition, and YAML anchors such as `&service` are file-local rather than a cross-file extension system.

## Logging

- every response gets an `x-request-id`
- admin responses send no-store cache headers
- admin requests are rate-limited in memory
- logs are JSON lines to stdout/stderr
- keep `LOG_HEALTHCHECKS=false` if you do not want `/healthz` poll noise

## Current Limits

- TLS termination stays in Traefik
- SSH tunnel lifecycle is manual
- rate limiting is in-memory only
- no request history yet
- host matching is exact by design
