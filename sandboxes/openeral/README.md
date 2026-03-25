# OpenEral Sandbox

This sandbox exists for one purpose: run Claude Code in OpenShell with a persistent PostgreSQL-backed home directory at `/home/agent`.

`/db` is mounted too, but it is secondary. The primary success criterion is that Claude writes `~/.claude` into `/home/agent` and that those files survive reconnects.

## Fresh Machine Inputs

Assume a fresh machine where only these are already available:

- upstream `openshell`
- a live PostgreSQL database
- the published openeral cluster image reference
- the published openeral sandbox image reference
- host `ANTHROPIC_API_KEY`

From there, the supported flow is:

1. start the gateway with the openeral cluster image
2. create one generic provider for the live database
3. launch Claude from the sandbox image

## Start Gateway

```bash
export OPENSHELL_CLUSTER_IMAGE='<cluster image ref>'
export OPENSHELL_REGISTRY_HOST='<registry host:port>'
export OPENSHELL_REGISTRY_INSECURE=true
export OPENSHELL_GATEWAY_NAME=openeral

openshell gateway start --name "$OPENSHELL_GATEWAY_NAME"
```

## Create Database Provider

```bash
export DATABASE_URL='host=<host> port=<port> user=<user> password=<password> dbname=<dbname>'
export OPENERAL_DB_PROVIDER=openeral-db

openshell provider create \
  --gateway "$OPENSHELL_GATEWAY_NAME" \
  --name "$OPENERAL_DB_PROVIDER" \
  --type generic \
  --credential DATABASE_URL
```

## One-Command Launch

```bash
export OPENERAL_SANDBOX_IMAGE='<sandbox image ref>'
export OPENERAL_SANDBOX_NAME=openeral-demo

set -a
. ./.env
set +a

openshell sandbox create \
  --gateway "$OPENSHELL_GATEWAY_NAME" \
  --name "$OPENERAL_SANDBOX_NAME" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider "$OPENERAL_DB_PROVIDER" \
  --provider claude \
  --auto-providers \
  --no-tty -- env HOME=/home/agent claude
```

This is the preferred and supported user flow:

- single `openshell` command
- no wrapper scripts
- no `sandbox upload`
- no manual `sandbox connect` just to start Claude

## Runtime Contract

When the sandbox is healthy:

- `/home/agent` is mounted read-write by `openeral`
- `/db` is mounted read-only by `openeral`
- Claude runs with `HOME=/home/agent`
- `.claude` files are written into PostgreSQL-backed storage

The sandbox image declares these mounts in `/etc/fstab`:

- `env /db fuse.openeral ro,allow_other,noauto 0 0`
- `env#workspace#${OPENSHELL_SANDBOX_ID} /home/agent fuse.openeral rw,allow_other,noauto 0 0`

OpenShell side-loads `openshell-sandbox`, which reads `/etc/fstab` and launches `mount.fuse3` before the child process starts. The database provider's `DATABASE_URL` is mapped to `OPENERAL_DATABASE_URL` for `openeral`.

## Persistence Rules

- `/home/agent` is the durable Claude home
- reconnect to the same sandbox: same workspace
- delete and recreate the sandbox: new workspace

If Claude is not running with `HOME=/home/agent`, persistence is not configured correctly.

## Quick Checks

Inside the sandbox, these are the checks that matter:

```bash
grep -E ' /db | /home/agent ' /proc/mounts
stat -c '%u:%g %a %n' /home/agent
HOME=/home/agent claude -p 'Reply with READY and nothing else.'
```

If you need to confirm persistence in PostgreSQL:

```sql
SELECT path, uid, gid, size
FROM _openeral.workspace_files
WHERE workspace_id = '<sandbox-id>'
ORDER BY path;
```

You should see Claude state files such as:

- `/.claude.json`
- `/.claude/settings.json`
- `/.claude/projects/...`

## Failure Meaning

- missing `/home/agent`:
  - OpenShell or FUSE bootstrap failed
- missing `/db`:
  - database provider or FUSE bootstrap failed
- Claude auth failure:
  - Anthropic credential issue, not an openeral mount issue
- state not preserved:
  - Claude was not run with `HOME=/home/agent`

## Image Notes

- `openshell sandbox create --from sandboxes/openeral` is not the supported user flow
- this image is meant to be published and referenced by image tag
- the image `ENTRYPOINT` is not the OpenShell control path; the supervisor mounts FUSE from `/etc/fstab`
