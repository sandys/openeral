# Plan: Socket.dev + secret injection via stock OpenShell (no fork)

## Key Insight

Socket.dev IS a remote npm registry. The sandbox calls it directly — no proxy chaining needed. OpenShell's stock `SecretResolver` handles credential injection for both Anthropic and Socket.dev using the same mechanism.

The iron proxy pattern (placeholder → real credential → forward to endpoint) is EXACTLY what stock OpenShell's `SecretResolver` + HTTP proxy already does for ALL provider credentials.

## How it works (stock OpenShell, no fork)

### Anthropic API (secret injection)

```
1. Provider: --provider claude → ANTHROPIC_API_KEY stored on gateway
2. Supervisor: child gets ANTHROPIC_API_KEY=openshell:resolve:env:ANTHROPIC_API_KEY
3. Claude Code: sends request with x-api-key: openshell:resolve:env:ANTHROPIC_API_KEY
4. Proxy: TLS terminate → scans headers → resolves placeholder → real key
5. Proxy: forwards to api.anthropic.com with real key
```

**Policy needed:**
```yaml
claude_code:
  endpoints:
    - host: api.anthropic.com
      port: 443
      protocol: rest
      tls: terminate    # enables L7 inspection + placeholder resolution
  binaries:
    - { path: /usr/local/bin/claude }
    - { path: /usr/bin/node }
```

No `secret_injection:` field — stock SecretResolver handles it automatically for ALL provider credentials.

### Socket.dev (package proxy)

Socket.dev provides a registry endpoint (`https://registry.socket.dev/npm/...`). npm can call it directly — no local proxy needed.

```
1. Provider: --provider socket → SOCKET_TOKEN stored on gateway
2. Supervisor: child gets SOCKET_TOKEN=openshell:resolve:env:SOCKET_TOKEN
3. setup.sh: npm config set //registry.socket.dev/:_authToken ${SOCKET_TOKEN}
4. setup.sh: npm config set registry https://registry.socket.dev/npm/
5. npm install: sends request to registry.socket.dev with auth token (placeholder)
6. Proxy: TLS terminate → scans headers → resolves placeholder → real token
7. Proxy: forwards to registry.socket.dev with real SOCKET_TOKEN
```

**Policy needed:**
```yaml
socket_packages:
  endpoints:
    - host: registry.socket.dev
      port: 443
      protocol: rest
      tls: terminate    # enables placeholder resolution in auth headers
  binaries:
    - { path: /usr/bin/npm }
    - { path: /usr/bin/node }
```

### What setup.sh does

```bash
# If socket provider is available, configure npm to use Socket.dev registry
if [ -n "$SOCKET_TOKEN" ]; then
  npm config set registry https://registry.socket.dev/npm/
  npm config set //registry.socket.dev/npm/:_authToken "$SOCKET_TOKEN"
fi
```

The `$SOCKET_TOKEN` value is the placeholder (`openshell:resolve:env:SOCKET_TOKEN`). When npm sends it in an HTTP header, the proxy resolves it to the real token.

## What to change

### 1. `sandboxes/openeral/policy.yaml` — rewrite

Remove all fork-specific fields (`secret_injection:`, `egress_via:`, `egress_profile:`). Add clean stock-compatible entries for Claude and Socket.dev.

Key: every endpoint that needs credential resolution must have `protocol: rest` + `tls: terminate` so the proxy can inspect and rewrite headers.

### 2. `sandboxes/openeral/setup.sh` — add Socket.dev config

If `SOCKET_TOKEN` env var is present (from Socket.dev provider), configure npm to use Socket.dev registry.

### 3. `README.md` — document both flows

Show how to set up:
- Claude Code with `--provider claude` (stock secret injection)
- Socket.dev with `--provider socket` (same mechanism, different endpoint)

### 4. Remove dead code

- Remove all references to our fork-specific features in README, CLAUDE.md, skills
- Remove `vendor/openshell/` references from docs (we use stock)

## Files to modify

- `sandboxes/openeral/policy.yaml` — rewrite (remove fork fields, add Socket.dev endpoint)
- `sandboxes/openeral/setup.sh` — add Socket.dev npm config
- `README.md` — document provider setup for Claude + Socket.dev
- `CLAUDE.md` — update

## Verification

1. Policy has zero fork-specific fields (`secret_injection:`, `egress_via:`, `egress_profile:`)
2. All endpoints needing credential resolution have `protocol: rest` + `tls: terminate`
3. Claude Code works via stock secret injection
4. If Socket.dev provider is configured, npm routes through Socket.dev
5. If Socket.dev provider is NOT configured, npm uses default registry
