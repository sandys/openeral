# openeral-shell

A persistent shell environment for AI agents. Your home directory, config, memory, and plans survive container restarts — backed by PostgreSQL. Claude Code comes pre-installed.

## Quick Start

```bash
cd openeral-shell
cp .env.example .env
# Edit .env and set your ANTHROPIC_API_KEY
docker compose up -d
docker compose exec openeral-shell claude
```

That's it. Claude Code runs with:

- **`/db/`** — your PostgreSQL database browsable as files (read-only)
- **`$HOME`** (`/home/agent`) — persistent home directory (read-write)
- **`~/.claude/`** — memory, plans, sessions, tasks all persist across restarts

## Setup

### 1. Set your API key

```bash
cd openeral-shell
cp .env.example .env
```

Edit `.env` and set your Anthropic API key:

```env
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### 2. Start

```bash
docker compose up -d
```

This starts PostgreSQL and the openeral-shell container. First build takes a few minutes (compiles from source).

### 3. Run Claude Code

```bash
# Interactive session
docker compose exec openeral-shell claude

# One-shot prompt
docker compose exec openeral-shell claude -p "explain the database schema at /db/"

# With a specific model
docker compose exec openeral-shell claude --model claude-sonnet-4-6

# Non-interactive with output
docker compose exec openeral-shell claude -p "write a plan to /home/agent/plans/my-plan.md" \
  --dangerously-skip-permissions
```

### 4. Or just get a shell

```bash
docker compose exec openeral-shell bash
```

## What's Pre-installed

- **Claude Code** (`claude` CLI) — ready to use with your API key
- **`/db/`** — PostgreSQL database mounted as browsable files
- **`$HOME`** — persistent home directory backed by PostgreSQL
- **bash, curl, git** — common shell tools

## What Persists

Everything under `$HOME` is stored in PostgreSQL and survives `docker compose down`/`up`:

| Path | What |
|------|------|
| `~/.claude/memory/` | Remembered context across conversations |
| `~/.claude/plans/` | Implementation plans |
| `~/.claude/sessions/` | Conversation transcripts |
| `~/.claude/tasks/` | Task tracking |
| `~/.claude/settings.json` | User preferences |
| `~/.config/`, `~/.cache/` | Application config and cache |
| Any file you create | Stored in PostgreSQL |

## Use Your Own PostgreSQL

By default, a bundled PostgreSQL is included. To connect to your own:

```bash
# Via environment variable
DATABASE_URL="postgres://user:pass@your-host/your-db" docker compose up -d

# Or edit docker-compose.yml directly
```

## Environment Variables

Set these in `.env` or `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required for Claude)* | Anthropic API key |
| `DATABASE_URL` | bundled postgres | PostgreSQL connection string |
| `WORKSPACE_ID` | `default` | Isolate state per agent |
| `WORKSPACE_CONFIG` | *(broad defaults)* | JSON: auto_dirs, seed_files |
| `STARTUP_TIMEOUT` | `15` | Seconds to wait for mounts |

## Default Directories

Auto-created under `$HOME` on first start:

```
.claude/          .claude/memory/    .claude/plans/
.claude/sessions/ .claude/tasks/     .claude/todos/
.claude/skills/   .cache/            .local/
.config/          .npm/
```

Override with `WORKSPACE_CONFIG` in `.env`:

```env
WORKSPACE_CONFIG={"auto_dirs":[".claude",".claude/memory",".myagent/data"],"seed_files":{".bashrc":"export PS1='agent> '"}}
```

## Multiple Agents

Use `WORKSPACE_ID` to isolate state per agent:

```env
WORKSPACE_ID=agent-alice
```

Each workspace ID gets its own isolated home directory in PostgreSQL.

## Skills

A built-in skill at `~/.claude/skills/openeral-shell/SKILL.md` teaches Claude Code how to use the environment — browsing `/db/`, writing persistent files, filtering, exporting. It's automatically installed on first start.

## Running Tests

```bash
bash openeral-shell/tests/test_openeral_shell.sh
```

## Docker Requirements

The container needs FUSE support (already configured in `docker-compose.yml`):

```yaml
devices:
  - /dev/fuse
cap_add:
  - SYS_ADMIN
security_opt:
  - apparmor:unconfined
```
