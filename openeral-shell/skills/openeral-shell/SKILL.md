---
name: openeral-shell
description: Navigate a PostgreSQL database mounted at /db (fuse.openeral) and manage persistent workspace at /home/agent
---

# Environment

Two FUSE mounts are available:

- **`/db/`** — PostgreSQL database as a read-only filesystem. Browse with `ls` and `cat`.
- **`/home/agent/`** — persistent read-write workspace backed by PostgreSQL. Everything you write survives restarts.

Your `~/.claude/` directory (memory, plans, sessions, tasks, todos, skills) persists automatically.

## Database Filesystem

```
/db/<schema>/<table>/
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

## Workflows

**Understand a table:**

```bash
cat /db/public/users/.info/columns.json    # what columns exist
cat /db/public/users/.info/count           # how many rows
cat /db/public/users/.info/schema.sql      # full DDL
cat /db/public/users/page_1/1/row.json     # sample row
```

**Find specific rows:**

```bash
# Filter by column value — runs a targeted SQL query, fast
ls /db/public/users/.filter/email/alice@example.com/
cat /db/public/users/.filter/id/42/42/row.json

# Sort by column
ls /db/public/orders/.order/created_at/desc/page_1/
```

**Export data:**

```bash
cat /db/public/users/.export/data.csv/page_1.csv
cat /db/public/users/.export/data.json/page_1.json
cat /db/public/users/.export/data.yaml/page_1.yaml
```

**Save work:**

```bash
# Everything under /home/agent/ persists
echo "findings" > ~/notes.md
mkdir -p ~/projects/analysis
```

## Rules

1. **`/db/` is read-only.** Writes return "Read-only file system".
2. **Check `.info/count` before scanning.** Large tables have thousands of pages — don't `ls` them all.
3. **Use `.filter/` for lookups.** It runs a targeted SQL query. Much faster than scanning pages.
4. **Pages hold up to 1000 rows.**
5. **Composite primary keys** appear as `col1=val1,col2=val2` directory names.
6. **NULL values** appear as empty files.
7. **`/home/agent/` is persistent.** Write freely — files are stored in PostgreSQL.
