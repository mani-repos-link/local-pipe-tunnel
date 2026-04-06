# local-pipe

`local-pipe` is a small host-based reverse proxy with a lightweight dashboard for SSH-backed localhost tunnels.

It is designed for this flow:

`Webhook/API -> Traefik -> local-pipe -> SSH reverse forward on VPS -> localhost`

## What It Does

- routes traffic by exact `Host()` match
- stores route mappings in `data/routes.json`
- gives a small dashboard to add, edit, enable, disable, and reload routes
- generates raw SSH reverse-tunnel commands per route
- works behind an existing Traefik setup

## Quick Start

1. Copy the env file and set your admin credentials.
2. Start the service with Docker Compose.
3. Add a DNS record and an explicit Traefik `Host()` router for each public tunnel host.
4. Create the matching route in the dashboard.
5. Open the SSH reverse tunnel from your local machine.

```bash
cp .env.example .env
docker compose up -d --build
```

Admin dashboard example:

```text
https://local-pipe.example.com
```

Example tunnel host:

```text
https://stripe.local-pipe.example.com
```

Example SSH command:

```bash
ssh -NT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:41001:127.0.0.1:3000 \
  tunnel@example-vps
```

## Files

- [`compose.yml`](./compose.yml): Docker Compose service definition
- [`.env.example`](./.env.example): environment variable template
- [`.traefik/compose.private.example.yml`](./.traefik/compose.private.example.yml): example private Traefik router override
- [`.traefik/private.labels.example`](./.traefik/private.labels.example): example private Traefik labels file
- [`src/dashboard/`](./src/dashboard): dashboard HTML, CSS, and client JS
- [`data/routes.example.json`](./data/routes.example.json): example route config
- [`docs/deployment.md`](./docs/deployment.md): DNS, Traefik, SSH, and deployment notes

## Development

Run locally:

```bash
cp data/routes.example.json data/routes.json
ADMIN_HOST=local-pipe.example.com \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=replace-this \
node src/server.js
```

Run tests:

```bash
npm test
```
