# Openrind Desktop Host (Docker)

## Dev testability stack (recommended for testing)

One command, no custom Dockerfile. Uses `node:22-bookworm-slim` off the shelf.

From the repo root:

```bash
./packaging/docker/dev-up.sh
```

Then open the printed Web UI URL (ports are randomized so you can run multiple stacks).

What it does:
- Starts **headless** (OpenCode + Openrind Desktop server) on port 8787
- Starts **web UI** (Vite dev server) on port 5173
- Auto-generates and shares auth tokens between services
- Web waits for headless health check before starting
- Builds Linux binaries inside the container (no host binary conflicts)
- Uses an isolated OpenCode dev state by default so the stack does not read your personal host config/auth/data

If you want to seed the container from your host OpenCode state for debugging, run with `OPENRIND_DESKTOP_DOCKER_DEV_MOUNT_HOST_OPENCODE=1`. This imports host config/auth into the isolated dev state instead of mounting live host state directly.

Useful commands:
- Logs: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml logs`
- Tear down: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml down`
- Health check: `curl http://localhost:<openrind_desktop_port>/health`

Optional env vars (via `.env` or `export`):
- `OPENRIND_DESKTOP_TOKEN` — fixed client token
- `OPENRIND_DESKTOP_HOST_TOKEN` — fixed host/admin token
- `OPENRIND_DESKTOP_WORKSPACE` — host path to mount as workspace
- `OPENRIND_DESKTOP_PORT` — host port to map to container :8787
- `WEB_PORT` — host port to map to container :5173
- `SHARE_PORT` — host port to map to the local share service :3000
- `OPENRIND_DESKTOP_PUBLIC_HOST` — host name/IP used in printed LAN/public URLs (defaults to your machine hostname)
- `OPENRIND_DESKTOP_DOCKER_DEV_MOUNT_HOST_OPENCODE=1` — import host OpenCode config/auth into the isolated dev state
- `OPENRIND_DESKTOP_OPENCODE_CONFIG_DIR` — override the host OpenCode config source used for that optional import
- `OPENRIND_DESKTOP_OPENCODE_DATA_DIR` — override the host OpenCode data source used for that optional import

The dev stack also starts the local share service automatically and points the Openrind Desktop app at it, so share-link flows publish to a local service instead of `https://share.openrind-desktoplabs.com`.

---

## Den local stack (Docker)

One command for the Den control plane, local MySQL, and the cloud web app.

From the repo root:

```bash
./packaging/docker/den-dev-up.sh
```

Or via pnpm:

```bash
pnpm dev:den-docker
```

What it does:
- Starts **MySQL** for the Den service
- Starts **Den control plane** on port 8788 inside Docker with `PROVISIONER_MODE=stub`
- Runs **Den migrations** automatically before the API starts
- Starts the **Openrind Desktop Cloud web app** on port 3005 inside Docker
- Points the web app's auth + API proxy routes at the local Den service
- Prints randomized host URLs so multiple stacks can run side by side

Useful commands:
- Logs: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml logs`
- Tear down: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml down`
- Tear down + reset DB: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml down -v`

Optional env vars (via `.env` or `export`):
- `DEN_API_PORT` — host port to map to the Den control plane :8788
- `DEN_WEB_PORT` — host port to map to the cloud web app :3005
- `DEN_BETTER_AUTH_SECRET` — Better Auth secret (auto-generated if unset)
- `DEN_PUBLIC_HOST` — host name/IP used for default auth URL + printed LAN/public URLs (defaults to your machine hostname)
- `DEN_BETTER_AUTH_URL` — browser-facing auth base URL (defaults to `http://$DEN_PUBLIC_HOST:<DEN_WEB_PORT>`)
- `DEN_MCP_RESOURCE_URL` — API-facing MCP resource URL (defaults to `http://localhost:<DEN_API_PORT>/mcp`)
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` — trusted origins for Better Auth (defaults to `DEN_CORS_ORIGINS`)
- `DEN_CORS_ORIGINS` — trusted origins for Express CORS (defaults include hostname, localhost, `127.0.0.1`, `0.0.0.0`, and detected LAN IPv4)
- `DEN_PROVISIONER_MODE` — `stub` or `render` (defaults to `stub`)
- `DEN_WORKER_URL_TEMPLATE` — stub worker URL template with `{workerId}` placeholder

### Faster inner-loop alternative

If you are iterating on Den locally and do not need the full Dockerized web stack, use the hybrid path instead:

From the Openrind Desktop repo root:

```bash
pnpm dev:den-local
```

Or from the Openrind Desktop enterprise root:

```bash
pnpm --dir _repos/openrind-desktop dev:den-local
```

What it does:
- Starts only **MySQL** in Docker
- Runs **Den controller** locally in watch mode
- Runs **Openrind Desktop Cloud web app** locally in Next.js dev mode
- Reuses the existing local-dev wiring in `scripts/dev-web-local.sh`

This is usually the fastest path for UI/auth/control-plane iteration because it avoids rebuilding the Docker web image on each boot.

---

## Pre-baked Micro-Sandbox Image

For micro-sandbox work, use the pre-baked image that compiles `openrind-desktop` and `openrind-desktop-server` from source and downloads the pinned `opencode` binary during `docker build`.

Build it from the repo root:

```bash
./scripts/build-microsandbox-openrind-desktop-image.sh
```

Run it locally:

```bash
docker run --rm -p 8787:8787 \
  -e OPENRIND_DESKTOP_CONNECT_HOST=127.0.0.1 \
  openrind-desktop-microsandbox:dev
```

Defaults:
- `OPENRIND_DESKTOP_TOKEN=microsandbox-token`
- `OPENRIND_DESKTOP_HOST_TOKEN=microsandbox-host-token`
- `OPENRIND_DESKTOP_APPROVAL_MODE=auto`

Verification:
- Health: `curl http://127.0.0.1:8787/health`
- Authenticated API call: `curl -H "Authorization: Bearer microsandbox-token" http://127.0.0.1:8787/workspaces`
- Docker health: `docker inspect --format '{{json .State.Health}}' <container>`

Useful overrides:
- `OPENRIND_DESKTOP_TOKEN` — set your own client bearer token
- `OPENRIND_DESKTOP_HOST_TOKEN` — set your own host/admin token
- `OPENRIND_DESKTOP_CONNECT_HOST` — host name embedded in the printed connect URL
- `DOCKER_PLATFORM` — optional platform passed to `docker build`

---

## Production container

This is a minimal packaging template to run the Openrind Desktop Host contract in a single container.

It runs:

- `opencode serve` (engine) bound to `127.0.0.1:4096` inside the container
- `openrind-desktop-server` published on `0.0.0.0:8787` via an explicit `--remote-access` launch path (the only published surface)

### Local run (compose)

From this directory:

```bash
docker compose up --build
```

Then open:

- `http://127.0.0.1:8787/ui`

### Config

Recommended env vars:

- `OPENRIND_DESKTOP_TOKEN` (client token)
- `OPENRIND_DESKTOP_HOST_TOKEN` (host/owner token)

Optional:

- `OPENRIND_DESKTOP_APPROVAL_MODE=auto|manual`
- `OPENRIND_DESKTOP_APPROVAL_TIMEOUT_MS=30000`

Persistence:

- Workspace is mounted at `/workspace`
- Host data dir is mounted at `/data` (OpenCode caches + Openrind Desktop server config/tokens)

### Notes

- OpenCode is not exposed directly; access it via the Openrind Desktop proxy (`/opencode/*`).
- For PaaS, replace `./workspace:/workspace` with a volume or a checkout strategy (git clone on boot).
