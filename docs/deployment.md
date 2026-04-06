# Deployment Notes

## Manual Host Plan

This project assumes:

- Traefik already handles TLS and public entry
- each tunnel host is added manually in DNS
- each tunnel host has an explicit Traefik `Host()` router

__If you have already a dns-01 resolver, you might not some steps like. creating manually new subdomain (sub.local-pipe.example.com) and neither need to modify the docker compose and adds labels manually in docker compose service.__

For this setup, you do not need a wildcard `dns-01` resolver (__if you have thats better__).

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
      "target": "http://host.docker.internal:41001",
      "enabled": true,
      "notes": "SSH reverse forward from localhost:3000",
      
      "sshTarget": "tunnel@example-vps",
      "remoteBindHost": "172.18.0.1",
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
- `sshTarget`, `remoteBindHost`, `localHost`, and `localPort` are optional metadata used by the dashboard SSH generator

## SSH Pattern

Example local command:

```bash
ssh -NT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R <bind-ip>:41001:127.0.0.1:3000 \
  tunnel@example-vps
```

Matching route:

- Host: `stripe.local-pipe.example.com`
- Target: `http://host.docker.internal:41001`
- Local app: `127.0.0.1:3000`

### Remote Bind Host Detection

`local-pipe` tries to avoid hardcoding a Docker host IP.

At startup it:

1. uses `DEFAULT_REMOTE_BIND_HOST` if set
2. otherwise detects the container gateway from `/proc/net/route`
3. otherwise falls back to resolving `host.docker.internal`

If detection still fails, set `DEFAULT_REMOTE_BIND_HOST` explicitly in `.env`.

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
- `DEFAULT_REMOTE_BIND_HOST`: optional override for VPS-side bind host
- `DEFAULT_LOCAL_HOST`: default local host for generated commands

See [`.env.example`](../.env.example) for the full list.

## Docker Deployment

The main deploy file is [`compose.yml`](../compose.yml).

Current defaults:

- non-root runtime user
- bind-mounted `data/` directory
- Compose-level healthcheck against `/healthz`
- explicit Traefik routers
- `host.docker.internal:host-gateway` mapping

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
- one sample tunnel router for `stripe.local-pipe.example.com`

For another tunnel host, duplicate the sample router labels and change only the router name and `Host()` rule.

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
