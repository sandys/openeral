# pgmount

Mount PostgreSQL databases as virtual filesystems using FUSE.

Browse schemas, tables, rows, and columns as directories and files. Filter, sort, and export data using standard shell commands.

```
$ pgmount mount -c "host=localhost dbname=myapp" /mnt/db

$ ls /mnt/db/public/users/
.export  .filter  .indexes  .info  .order  1  2  3

$ cat /mnt/db/public/users/1/name
Alice

$ cat /mnt/db/public/users/1/row.json
{
  "id": 1,
  "name": "Alice",
  "email": "alice@example.com",
  "age": 30,
  "active": true
}

$ ls /mnt/db/public/users/.filter/active/true/
1  3

$ cat /mnt/db/public/users/.export/data.csv
id,name,email,age,active
1,Alice,alice@example.com,30,true
2,Bob,bob@example.com,25,false
3,Charlie,charlie@example.com,35,true
```

## Features

- **Browse database structure** as a directory tree: schemas / tables / rows / columns
- **Read column values** as plain text files
- **Row serialization** in JSON, CSV, and YAML (`row.json`, `row.csv`, `row.yaml`)
- **Bulk export** via `.export/data.json`, `.export/data.csv`, `.export/data.yaml`
- **Filter rows** with `.filter/<column>/<value>/` directories
- **Sort rows** with `.order/<column>/asc/` or `.order/<column>/desc/`
- **Inspect metadata** via `.info/columns.json`, `.info/schema.sql`, `.info/count`, `.info/primary_key`
- **View indexes** via `.indexes/<index_name>` files
- **Composite primary keys** displayed as `col1=val1,col2=val2` directories
- **NULL handling** -- NULL values read as `NULL`
- **Tables/columns with special characters** (spaces, quotes) handled correctly
- **Metadata caching** with configurable TTL
- **Connection pooling** via deadpool-postgres (16 connections)
- **Multiple schemas** -- all non-system schemas mounted, or filter with `--schemas`

## Filesystem Layout

```
/mnt/db/
  <schema>/                          # e.g. public/
    <table>/                         # e.g. users/
      .info/
        columns.json                 # column metadata as JSON array
        schema.sql                   # approximate CREATE TABLE DDL
        count                        # exact row count
        primary_key                  # PK column name(s)
      .export/
        data.json                    # all rows as JSON array
        data.csv                     # all rows as CSV
        data.yaml                    # all rows as YAML
      .filter/
        <column>/                    # e.g. active/
          <value>/                   # e.g. true/
            <pk>/...                 # matching row directories
      .order/
        <column>/                    # e.g. name/
          asc/                       # rows sorted ascending
            <pk>/...
          desc/                      # rows sorted descending
            <pk>/...
      .indexes/
        <index_name>                 # index metadata file
      <pk_value>/                    # row directory (e.g. 1/ or col1=a,col2=b/)
        <column_name>               # column value as text file
        row.json                     # full row as JSON
        row.csv                      # full row as CSV
        row.yaml                     # full row as YAML
```

## Installation

### Requirements

- Rust 1.85+
- FUSE 3 (`libfuse3-dev` on Debian/Ubuntu, `fuse3` on Fedora/Arch)
- PostgreSQL client libraries (`libpq-dev`)

### Build from source

```bash
cargo build --release
sudo cp target/release/pgmount /usr/local/bin/
```

## Usage

### Mount a database

```bash
# Using a connection string
pgmount mount -c "host=localhost user=postgres dbname=myapp" /mnt/db

# Using a PostgreSQL URI
pgmount mount -c "postgres://user:pass@localhost/myapp" /mnt/db

# Using environment variable
export PGMOUNT_DATABASE_URL="host=localhost dbname=myapp"
pgmount mount /mnt/db
```

### Options

```
pgmount mount [OPTIONS] <MOUNT_POINT>

Arguments:
  <MOUNT_POINT>    Path where the filesystem will be mounted

Options:
  -c, --connection <CONNECTION>    PostgreSQL connection string
  -s, --schemas <SCHEMAS>          Only show these schemas (comma-separated)
      --cache-ttl <SECONDS>        Metadata cache TTL [default: 30]
      --page-size <N>              Max rows per directory listing [default: 1000]
      --read-only <BOOL>           Mount read-only [default: true]
  -f, --foreground                 Run in foreground
```

### Unmount

```bash
pgmount unmount /mnt/db
# or
fusermount -u /mnt/db
```

### List active mounts

```bash
pgmount list
```

### Browsing examples

```bash
# List schemas
ls /mnt/db/

# List tables in a schema
ls /mnt/db/public/

# List rows in a table (shown as PK-value directories)
ls /mnt/db/public/users/

# Read a single column value
cat /mnt/db/public/users/42/email

# Get full row as JSON
cat /mnt/db/public/users/42/row.json

# Export entire table as CSV
cat /mnt/db/public/users/.export/data.csv > users_backup.csv

# View table metadata
cat /mnt/db/public/users/.info/count
cat /mnt/db/public/users/.info/primary_key
cat /mnt/db/public/users/.info/schema.sql

# Filter rows by column value
ls /mnt/db/public/users/.filter/active/true/

# Sort rows
ls /mnt/db/public/users/.order/name/asc/

# Read data through a filtered view
cat /mnt/db/public/users/.filter/active/true/1/row.json

# View indexes
ls /mnt/db/public/users/.indexes/
cat /mnt/db/public/users/.indexes/users_pkey
```

## Architecture

```
pgmount/
  crates/
    pgmount/          # CLI binary
    pgmount-core/     # Library
      src/
        cli/           # Clap command definitions
        config/        # Connection string resolution, YAML config
        db/            # Connection pool and SQL queries
          queries/     # Introspection, row access, indexes, stats
        fs/            # FUSE filesystem implementation
          nodes/       # Node types: root, schema, table, row, column,
                       #   info, export, indexes, filter, order
        format/        # JSON, CSV, YAML serializers
        mount/         # Mount registry
```

| Layer | Crate | Purpose |
|-------|-------|---------|
| FUSE | `fuser` 0.17 | Kernel filesystem interface |
| PostgreSQL | `tokio-postgres` + `deadpool-postgres` | Async queries with connection pooling |
| Async | `tokio` | Runtime for database operations |
| CLI | `clap` v4 | Command-line argument parsing |
| Caching | `dashmap` | Lock-free concurrent inode table and metadata cache |
| Serialization | `serde_json`, `csv`, `serde_yml` | Row format output |
| Errors | `thiserror` | Ergonomic error types with errno mapping |
| Logging | `tracing` | Structured, filterable logging |

### Key design decisions

**Async bridge**: `fuser` callbacks run on OS threads; database calls are async. Each FUSE callback uses `tokio::runtime::Handle::block_on()` to execute async queries.

**Inode allocation**: Lazy and deterministic within a mount session. A `NodeIdentity` enum describes every virtual node type. A `DashMap` ensures the same identity always maps to the same inode number.

**File content**: `getattr` reports an estimated size (4096). On `open`, the full content is generated and cached in a file-handle map. `read` slices from this cache.

**Type handling**: All column values are cast to `::text` in SQL, avoiding Rust type-mapping issues with PostgreSQL types like NUMERIC, MONEY, or custom domains.

## Development

All development runs inside Docker containers:

```bash
# Start the dev environment (Rust 1.85 + PostgreSQL 16)
docker compose up -d

# Build inside the container
docker compose exec dev cargo build

# Run Rust unit/integration tests (22 tests)
docker compose exec dev cargo test -p pgmount-core

# Run FUSE mount integration tests (105 assertions)
docker compose exec -e PGPASSWORD=pgmount dev bash tests/test_fuse_mount.sh

# Run clippy
docker compose exec dev cargo clippy

# Stop everything
docker compose down
```

### Docker Compose services

| Service | Description |
|---------|-------------|
| `dev` | Rust 1.85 with FUSE3, mounted with `/dev/fuse` and `SYS_ADMIN` capability |
| `postgres` | PostgreSQL 16 (`pgmount:pgmount@postgres/testdb`) |

## License

MIT
