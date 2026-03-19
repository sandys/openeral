---
name: pgmount-dev
description: Use when working on the pgmount project — building, testing, debugging, adding features, or understanding the codebase. pgmount mounts PostgreSQL databases as FUSE virtual filesystems.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
argument-hint: [task description]
---

# pgmount Development

pgmount is a Rust project that mounts PostgreSQL databases as read-only FUSE virtual filesystems. Users browse schemas, tables, rows, and columns as directories and files.

## Project Structure

```
pgmount/
├── Cargo.toml                          # Workspace root
├── Dockerfile.dev                      # Rust 1.85 + FUSE3 + libpq
├── docker-compose.yml                  # dev (Rust) + postgres (PG 16) services
├── crates/
│   ├── pgmount/                        # Binary crate (CLI entry point)
│   │   └── src/main.rs                 # Tokio main, tracing init, calls cli::run()
│   └── pgmount-core/                   # Library crate (all logic)
│       ├── src/
│       │   ├── lib.rs                  # Module declarations
│       │   ├── error.rs                # FsError enum → fuser::Errno mapping
│       │   ├── cli/                    # Clap v4 commands
│       │   │   ├── mod.rs              # Cli struct, Commands enum, run()
│       │   │   ├── mount.rs            # Mount subcommand (pool + fuser::mount2)
│       │   │   ├── unmount.rs          # fusermount -u wrapper
│       │   │   ├── list.rs             # Reads /proc/mounts for pgmount entries
│       │   │   └── version.rs          # Prints CARGO_PKG_VERSION
│       │   ├── config/                 # Connection resolution
│       │   │   ├── mod.rs
│       │   │   ├── types.rs            # MountConfig, PgmountConfig, ConnectionConfig
│       │   │   └── connection.rs       # CLI arg > env var > ~/.pgmount/config.yml
│       │   ├── db/                     # PostgreSQL layer
│       │   │   ├── mod.rs
│       │   │   ├── pool.rs             # deadpool-postgres pool (max 16)
│       │   │   ├── types.rs            # SchemaInfo, TableInfo, ColumnInfo, etc.
│       │   │   └── queries/
│       │   │       ├── mod.rs          # Public quote_ident()
│       │   │       ├── introspection.rs # list_schemas/tables/columns, get_primary_key
│       │   │       ├── rows.rs         # list_rows, get_row_data, get_column_value
│       │   │       ├── indexes.rs      # list_indexes from pg_class/pg_index
│       │   │       └── stats.rs        # Row count estimate + exact
│       │   ├── fs/                     # FUSE filesystem
│       │   │   ├── mod.rs              # PgmountFilesystem (impl fuser::Filesystem)
│       │   │   ├── inode.rs            # InodeTable + NodeIdentity enum
│       │   │   ├── attr.rs             # FileAttr helpers (dir_attr, file_attr)
│       │   │   ├── cache.rs            # MetadataCache with TTL
│       │   │   └── nodes/              # One file per virtual node type
│       │   │       ├── mod.rs          # Dispatch: node_lookup/readdir/read/getattr
│       │   │       ├── root.rs         # / → lists schemas
│       │   │       ├── schema.rs       # /public/ → lists tables
│       │   │       ├── table.rs        # /public/users/ → rows + special dirs
│       │   │       ├── row.rs          # /public/users/1/ → columns + format files
│       │   │       ├── column.rs       # /public/users/1/name → column value text
│       │   │       ├── row_file.rs     # row.json / row.csv / row.yaml
│       │   │       ├── info.rs         # .info/ → columns.json, schema.sql, count, primary_key
│       │   │       ├── export.rs       # .export/ → data.json, data.csv, data.yaml
│       │   │       ├── indexes.rs      # .indexes/ → index metadata files
│       │   │       ├── filter.rs       # .filter/<col>/<val>/ → filtered rows
│       │   │       └── order.rs        # .order/<col>/asc|desc/ → sorted rows
│       │   ├── format/                 # Serializers
│       │   │   ├── mod.rs
│       │   │   ├── json.rs            # format_row / format_rows (smart type inference)
│       │   │   ├── csv.rs             # CSV with headers
│       │   │   └── yaml.rs            # YAML via serde_yml
│       │   └── mount/
│       │       ├── mod.rs
│       │       └── registry.rs         # MountRegistry (DashMap tracking)
│       └── tests/
│           └── integration.rs          # 22 Rust integration tests
└── tests/
    └── test_fuse_mount.sh              # 105-assertion FUSE mount test suite
```

## Key Architecture

### Async Bridge
fuser callbacks are sync (OS threads). Database calls use tokio-postgres (async). Each FUSE callback calls `handle.block_on(async_fn)` to bridge them.

### Inode Allocation
`NodeIdentity` enum describes every virtual node. `InodeTable` (DashMap) maps identity ↔ inode. Same identity = same inode within a session. Root = inode 1.

### Node Dispatch
`fs/nodes/mod.rs` has four dispatch functions: `node_getattr`, `node_lookup`, `node_readdir`, `node_read`. Each matches on `NodeIdentity` and delegates to the appropriate node module.

### File Content Strategy
`getattr` reports estimated size 4096. On `open`, content is generated and cached in an `OpenFileHandle` map. `read` slices from this cache.

### SQL Type Handling
All values cast to `::text` in SQL queries. This avoids Rust type-mapping issues with NUMERIC, MONEY, custom domains, etc.

## Development Workflow

**ALL builds and tests run inside Docker containers:**

```bash
# Start environment
docker compose up -d

# Build
docker compose exec dev cargo build

# Run Rust tests (22 tests, uses dedicated rust_test schema)
docker compose exec dev cargo test -p pgmount-core

# Run FUSE mount integration tests (105 assertions)
docker compose exec -e PGPASSWORD=pgmount dev bash tests/test_fuse_mount.sh

# Lint
docker compose exec dev cargo clippy

# Manual testing: mount and browse
docker compose exec dev mkdir -p /mnt/db
docker compose exec -d dev /workspace/target/debug/pgmount mount \
  -c "host=postgres user=pgmount password=pgmount dbname=testdb" /mnt/db
docker compose exec dev ls /mnt/db/public/
docker compose exec dev cat /mnt/db/public/users/1/row.json
docker compose exec dev fusermount -u /mnt/db
```

**PostgreSQL test credentials:** `pgmount:pgmount@postgres/testdb`

## Adding a New Node Type

To add a new virtual directory/file type (e.g., `.sample/`):

1. Add variant(s) to `NodeIdentity` enum in `fs/inode.rs`
2. Create `fs/nodes/sample.rs` with `lookup`, `readdir`, and/or `read` functions
3. Add `pub mod sample;` to `fs/nodes/mod.rs`
4. Wire into the dispatch functions in `fs/nodes/mod.rs`:
   - `node_lookup` — handle the parent identity that contains this node
   - `node_readdir` — list children
   - `node_read` — return file content (for leaf files)
   - `node_getattr` — return dir or file attrs
5. If it's a special dir under tables, add to `SPECIAL_DIRS` in `fs/nodes/table.rs`
6. Add tests to `tests/test_fuse_mount.sh`

## Adding a New SQL Query

1. Add the function to the appropriate file in `db/queries/`
2. Use `pool.get().await` for a connection
3. Use parameterized queries (`$1`, `$2`, etc.)
4. Use `quote_ident()` from `db::queries` for dynamic identifiers
5. Cast results to `::text` when returning user-facing string data

## NodeIdentity Enum (Complete)

```
Root
Schema { name }
Table { schema, table }
SpecialDir { schema, table, kind: Info|Export|Filter|Order|Indexes|... }
Row { schema, table, pk_display }
Column { schema, table, pk_display, column }
RowFile { schema, table, pk_display, format: json|csv|yaml }
FilterDir { schema, table, stage: Root|Column|Value }
OrderDir { schema, table, stage: Root|Column|Direction }
LimitDir { schema, table, kind: First|Last, n }
ByIndexDir { schema, table, stage: Root|Column|Value }
InfoFile { schema, table, filename }
ExportFile { schema, table, format }
IndexDir { schema, table }
IndexFile { schema, table, index_name }
ViewsDir { schema }
View { schema, view_name }
```

## Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| fuser | 0.17 | FUSE filesystem trait |
| tokio | 1 | Async runtime |
| tokio-postgres | 0.7 | PostgreSQL async driver |
| deadpool-postgres | 0.14 | Connection pooling |
| clap | 4 | CLI argument parsing |
| dashmap | 6 | Lock-free concurrent maps |
| serde_json | 1 | JSON serialization |
| csv | 1 | CSV serialization |
| serde_yml | 0.0.12 | YAML serialization |
| thiserror | 2 | Error type derivation |
| tracing | 0.1 | Structured logging |
| chrono | 0.4 | Date/time types |
| libc | 0.2 | System call constants |
