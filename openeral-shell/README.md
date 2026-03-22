# openeral-shell

An OpenShell sandbox that mounts a PostgreSQL database as a browsable filesystem and gives agents a persistent home directory — both backed by PostgreSQL.

## How It Works

openeral-shell starts two FUSE mounts inside the container. `/db/` exposes your PostgreSQL database as a read-only hierarchy of schemas, tables, rows, and columns — navigable with `ls` and `cat`, no SQL required. `/home/agent/` is a read-write workspace where every file persists in PostgreSQL across container restarts.

## Quick Start

```bash
# 1. Create .env (from repo root)
cat > .env <<'EOF'
DATABASE_URL=postgres://user:pass@host/db
ANTHROPIC_API_KEY=sk-ant-...
EOF

# 2. Create the sandbox
openshell sandbox create --from . --upload .env

# 3. Connect
openshell sandbox connect <sandbox-name> -- claude
```

## What's Inside

- **`/db/`** — your database as files. Schemas are directories, tables are directories, rows are directories containing column files. Includes metadata (`.info/`), filtered views (`.filter/`), sorted views (`.order/`), and bulk exports (`.export/`).
- **`/home/agent/`** — persistent workspace. Everything written here survives container restarts. Agent state (`~/.claude/memory/`, `~/.claude/plans/`, etc.) is automatically provisioned.
- **Pre-installed skill** — teaches agents how to navigate `/db/` and use the workspace.
- **Landlock security policy** — `/db/` is read-only, `/home/agent/` is read-write, system directories are locked.

## Database Filesystem

```
/db/
  <schema>/
    <table>/
      .info/
        columns.json         column names, types, nullability
        schema.sql           CREATE TABLE DDL
        count                exact row count
        primary_key          primary key column(s)
      .export/
        data.json/           paginated JSON  (page_1.json, page_2.json, ...)
        data.csv/            paginated CSV
        data.yaml/           paginated YAML
      .filter/<col>/<val>/   rows where column = value (paginated)
      .order/<col>/asc/      rows sorted ascending (paginated)
      .order/<col>/desc/     rows sorted descending (paginated)
      .indexes/<name>        index definitions
      page_1/
        <pk_value>/          row directory (named by primary key)
          <column>           column value as plain text
          row.json           full row as JSON
          row.csv            full row as CSV
          row.yaml           full row as YAML
      page_2/
      ...
```

### Examples

```bash
ls /db/                                          # list schemas
ls /db/public/                                   # list tables
cat /db/public/users/.info/columns.json          # column definitions
cat /db/public/users/.info/count                 # row count

cat /db/public/users/page_1/42/row.json          # row 42 as JSON
cat /db/public/users/page_1/42/email             # single column value

ls /db/public/users/.filter/active/true/         # filtered rows
cat /db/public/orders/.order/created_at/desc/page_1/1001/row.json

cat /db/public/users/.export/data.csv/page_1.csv # bulk export
```

## Environment Variables

Set in `.env` and uploaded via `--upload .env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | *(required for Claude Code)* | Anthropic API key |
| `WORKSPACE_ID` | `default` | Isolate state per agent |
| `WORKSPACE_CONFIG` | *(broad defaults)* | JSON with `auto_dirs` and `seed_files` |
| `STARTUP_TIMEOUT` | `15` | Seconds to wait for mounts |

## Multiple Agents

Each `WORKSPACE_ID` gets its own isolated `/home/agent/`:

```env
WORKSPACE_ID=agent-alice
```

## Security

- **Landlock policy** — `/db/` read-only, `/home/agent/` read-write, system directories locked
- **FUSE isolation** — database and workspace are independent mounts
- **Non-root execution** — runs as `sandbox` user (UID 1000)
- **SYS_ADMIN scoped** — capability used only for FUSE mount operations
