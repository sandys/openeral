# Openrind Shell FUSE Runtime: First-Class OpenShell Design

**Status:** implemented experimental candidate; correctness and rollout contract

**Revision:** 2.3

**Date:** 2026-08-15

**OpenShell source pin:**
[`c4b500a7de64d0b66e3ee8098f58d14299092162`](https://github.com/NVIDIA/OpenShell/tree/c4b500a7de64d0b66e3ee8098f58d14299092162),
recorded in `vendor/openshell/UPSTREAM`

**Audience:** the coding tool implementing OpenShell and Openrind Shell changes, and the
reviewers responsible for security, filesystem correctness, and operability

This document is the implementation and review contract. [FUSE.md](FUSE.md) is the
alternatives survey. This design supersedes every older proposal that used scoped sync as the
primary runtime, a host volume plugin as the selected route, the historical whole-file
FUSE implementation, an in-place remount loop, or a long-running trailing SSH command.

The current worktree implements the first-class OpenShell request/policy/driver/
supervisor path, normalized PostgreSQL schema, Rust FUSE daemon, primary and
compatibility images, and a Docker-driver E2E harness. Completed live checks cover
FUSE conformance, supervisor/container recovery with lease-epoch advance,
delete/recreate persistence, and a real Claude Code write restored from PostgreSQL.
Performance gates, upstream acceptance, non-Docker drivers, same-UID hardening, and a
supervisor-owned deadlock watchdog remain open; the runtime is therefore experimental.

## 1. Decisions

The implementation must preserve these decisions unless the product owner explicitly
changes them:

| Decision | Selected behavior |
|---|---|
| Product default | FUSE replaces scoped sync in the primary Openrind Shell sandbox image. |
| Persistent scope | Project workspace uses PostgreSQL FUSE at `/sandbox/work`; Claude home uses a per-workspace Docker named volume at `/sandbox/claude-home`. |
| Claude environment | `HOME=/sandbox/claude-home`; default cwd `/sandbox/work`. |
| Backing store | External PostgreSQL is mandatory. PGlite is unsupported in this image. |
| Write contract | Ordinary writes are buffered under strict limits; `fsync`/`fdatasync` are general durability barriers; dirty-source rename and close after an existing-file `O_TRUNC` rewrite are narrow ordering barriers. |
| Driver | Docker only for v1. Podman, Kubernetes, and MicroVM reject the request. |
| OpenShell integration | First-class FUSE resource requirement and static policy, plus the public Docker named-volume driver configuration for Claude home. |
| Mount owner | OpenShell supervisor mounts; Claude never receives mount capability. |
| Daemon security | Spawn after supervisor hardening via the normal unprivileged child path. |
| Crash recovery | FUSE daemon exit terminates the supervisor/container; Docker reconstructs the mount namespace. No in-place remount. |
| Migration owner | TypeScript/Openrind Shell initialization owns all PostgreSQL schema migration. The Rust daemon never migrates. |
| Persistence authority | Each path has one authority: FUSE for `/sandbox/work`, Docker volume for `/sandbox/claude-home`. The watcher is removed from this runtime. |
| Historical Rust code | Evidence and test cases only; do not revive it wholesale. |

These are explicit product decisions, not accidental consequences of the technical
design. They deliberately replace the primary image's optional-PGlite and scoped-sync
contract. The existing scoped-sync image remains available under a different tag until
the FUSE runtime passes every rollout gate in this document. First-class OpenShell
integration is also deliberate: "minimize the OpenShell patch" means the smallest
default-off, security-coherent public capability, not the smallest possible file count.

The decisions have concrete customer consequences:

- the primary FUSE image refuses to start Claude without a reachable external
  PostgreSQL datasource;
- one mounted namespace persists both Claude state and project files, eliminating the
  watcher/FUSE split-brain case;
- ordinary writes may be lost unless covered by `fsync`, synchronous I/O, or one of
  the two narrow safe-replacement barriers in section 9.2;
- Docker is the only supported driver in v1;
- users who require optional persistence or PGlite use the separately named
  compatibility image instead of receiving a silent behavioral switch.

## 2. Source-Verified Constraints

### 2.1 OpenShell process model

The Docker driver replaces the image entrypoint with the mounted OpenShell supervisor
and sets the managed workload to `sleep infinity`. A command after
`openshell sandbox create ... --` runs later through SSH. Therefore a trailing command
may initialize the filesystem but may not own its daemon.

Relevant source at the pin:

- `crates/openshell-driver-docker/src/lib.rs`: supervisor entrypoint,
  `OPENSHELL_SANDBOX_COMMAND`, and Docker container construction.
- `crates/openshell-sandbox/src/main.rs`: workload-command resolution.
- `crates/openshell-cli/src/run.rs` and `ssh.rs`: trailing-command SSH execution.

### 2.2 Mount ordering

`crates/openshell-supervisor-process/src/run.rs` currently performs privileged
filesystem preparation and then calls `apply_supervisor_startup_hardening()` before
opening SSH or spawning the workload. The supervisor prelude applies a process-wide
TSYNC seccomp filter that blocks:

```text
mount, umount2, fsopen, fsconfig, fsmount, fspick,
move_mount, open_tree, pivot_root
```

The initial FUSE mount must therefore happen **after normal filesystem preparation but
before the supervisor prelude**. Remount after that point is intentionally impossible.

### 2.3 Child security path

`ProcessHandle::spawn` prepares and enforces the child policy, enters the workload
network namespace, drops to the configured sandbox UID/GID, sets `no_new_privs`,
applies Landlock and child seccomp, strips supervisor-only environment, and injects
the approved proxy/TLS/provider environment. `openrind-shell-fused` must use this path.

Do not spawn the daemon before startup hardening. A pre-hardening daemon would inherit
root or supervisor privileges and become a larger escape surface than the agent.

### 2.4 Missing inherited-fd support

`ProcessHandle` currently has no API for explicit fd inheritance/remapping. The
supervisor cannot safely assume fd 3 because its runtime already owns unrelated fds.
The OpenShell patch must add an explicit mapping API and install mappings in the child
`pre_exec` path before restrictions are applied.

### 2.5 Missing critical-child support

`managed_children.rs` is only a PID `HashSet`; it prevents the orphan reaper from
racing explicit waiters. It does not restart or classify services. The main run loop
waits on the workload only. FUSE requires a separate explicitly awaited critical
child.

### 2.6 Current restart behavior

The Docker driver currently creates sandboxes with `restart_policy: unless-stopped`,
and the latest upstream release adds `sandbox stop`/`sandbox start` with
`Stopping`/`Stopped`/`Starting` phases and lifecycle fencing.

However, Docker `RESTARTING` is reported as `Ready=False,
reason=ContainerRestarting`, while the gateway's `is_terminal_failure_reason()` does
not list that reason as transient. Polling can also observe the short `EXITED` state
before Docker begins the restart. The implementation must give critical-service exit
its own reserved status/reason and fix both mappings before relying on automatic
restart for FUSE recovery.

### 2.7 The pristine upstream pin has no FUSE capability

At the pristine pin there was no `/dev/fuse` device injection, FUSE resource requirement,
`fuse_mounts` policy schema, inherited-fd child API, or critical child. Existing
driver-config mounts added by PR #1785 do not solve in-sandbox FUSE.

Those capabilities now exist only in this repository's vendored patch. They are not
claims about released upstream OpenShell.

## 3. Target Architecture

```text
OpenShell gateway and Docker driver
  -> create container with /dev/fuse only when the request and operator gate agree
  -> PID 1: openshell-sandbox
       -> prepare workspace and mountpoint
       -> open /dev/fuse
       -> mount(openrind-shell, /sandbox/work, fuse, fd=N, ...)
       -> apply supervisor TSYNC seccomp prelude
       -> spawn openrind-shell-fused as a normal sandbox child with mapped FUSE fd
       -> spawn SSH and sleep-infinity workload
       -> await workload, shutdown signal, or critical daemon exit

Claude / git / npm / compiler
  -> kernel VFS at /sandbox/work
  -> FUSE fd
  -> openrind-shell-fused (sandbox UID, Landlock, seccomp, netns)
  -> HTTP CONNECT through OpenShell proxy
  -> PostgreSQL TLS session inside the CONNECT tunnel
  -> _openeral.fs_* tables
```

The FUSE daemon starts before the uploaded database URL and migrations are available.
It must complete the kernel FUSE handshake, keep the mount alive, and wait at most five
seconds before returning `EIO` for ordinary data operations until the init-owned
database coordination marker appears. That marker is same-UID writable and is not a
supervisor or security trust signal. The daemon must not exit merely because
initialization has not run yet, or a missing upload would cause a restart loop.

OpenShell's configured workspace root remains `/sandbox`. The mountpoint
`/sandbox/work` is a child of that root; only the Claude wrapper changes `HOME` and cwd
to the mount. Making `/sandbox/work` the OCI workspace root would violate the policy
rule that a mountpoint must be below, rather than equal to, the workspace root and
would make the pre-database initialization command depend on the unavailable mount.

## 4. OpenShell Public API

### 4.1 Resource requirement

Add an empty, forward-compatible FUSE requirement to **both** public and driver proto
models:

```proto
message ResourceRequirements {
  GpuResourceRequirements gpu = 1;
  FuseResourceRequirements fuse = 2;
}

message FuseResourceRequirements {}
```

Required propagation points include:

- `proto/openshell.proto`
- `proto/compute_driver.proto`
- CLI request construction and tests
- `openshell-sdk` request helpers
- server public-to-driver mapping in `compute/mod.rs`
- gateway interceptor/proto-JSON tests
- generated Rust, Python, Go, TypeScript, and Fern/API artifacts according to the
  repository's normal generation tasks
- every struct literal for `ResourceRequirements`

The CLI surface is:

```text
openshell sandbox create --fuse ...
```

The flag sets presence of `resource_requirements.fuse`. It does not itself define a
mountpoint or daemon binary; those remain immutable image policy.

### 4.2 Driver support and operator gate

Add `enable_fuse: bool` to `DockerComputeConfig`, default `false`. This is an
operator-owned driver setting, not user-controlled `driver_config`.

Creation rules:

- request has no `fuse`: preserve current behavior exactly;
- request has `fuse`, Docker `enable_fuse=false`: reject before container creation
  with `FailedPrecondition`;
- request has `fuse`, `/dev/fuse` is absent on the gateway host: reject with a
  diagnostic that names the host requirement;
- Podman, Kubernetes, and VM: reject `fuse` with `FailedPrecondition` in v1.

When enabled and requested, Docker adds exactly one HostConfig device mapping:

```text
PathOnHost: /dev/fuse
PathInContainer: /dev/fuse
CgroupPermissions: rwm
```

Do not add `--privileged`, general device passthrough, or extra workload capabilities.
For FUSE-requested containers only, set Docker restart policy to `on-failure` with
`maximum_retry_count=5`. Non-FUSE sandboxes retain upstream `unless-stopped`. This
bounds a broken FUSE image without introducing a second gateway-side crash budget.
The driver records a label identifying the FUSE request and inspects container exit
code plus Docker restart count when mapping state.
The driver also sets a supervisor-only marker such as
`OPENSHELL_FUSE_REQUESTED=1`. The supervisor strips this variable from every child and
requires an exact match between that marker and a nonempty effective initial
`fuse_mounts` policy. This is the authoritative policy/resource consistency check:
OpenShell does not always send image-embedded policy through the gateway at create
time, because the supervisor may discover `/etc/openshell/policy.yaml` after the
container starts. If an explicit policy is present in the public create request, the
gateway may reject an obvious mismatch early, but it cannot replace the supervisor
check. Never silently skip a requested or declared mount.

## 5. Static FUSE Policy

### 5.1 Schema

Add a static policy field to `proto/sandbox.proto`:

```proto
message SandboxPolicy {
  // existing fields ...
  repeated FuseMount fuse_mounts = 7;
}

message FuseMount {
  string binary = 1;
  repeated string args = 2;
  string mountpoint = 3;
  string fs_name = 4;
  bool allow_other = 5;
  uint32 startup_timeout_seconds = 6;
}
```

Canonical image policy:

```yaml
fuse_mounts:
  - binary: /usr/local/bin/openrind-shell-fused
    args: ["serve"]
    mountpoint: /sandbox/work
    fs_name: openrind-shell
    allow_other: false
    startup_timeout_seconds: 30
```

Add the field through:

- `openshell-policy` YAML `PolicyFile` serde definitions, parse, serialize, and
  round-trip tests (`deny_unknown_fields` currently rejects it);
- core `SandboxPolicy` and proto conversion;
- supervisor policy loading;
- policy schema documentation and static-field classification;
- policy set/update validation so a running sandbox cannot mutate `fuse_mounts`;
- prover/model behavior as needed so the new field is preserved rather than dropped.

Network policy remains dynamic. FUSE mount declarations are immutable because the
supervisor cannot mount after startup hardening.

### 5.2 Validation

Reject the sandbox before the mount syscall unless every entry satisfies:

- one mount only in v1;
- absolute normalized mountpoint;
- mountpoint is below the configured workspace root but is not the workspace root
  itself;
- configured workspace root is `/sandbox` for the Openrind Shell image; reject an image or
  request that resolves it to `/sandbox/work`;
- no overlap with OpenShell control roots, SSH socket, TLS paths, netns paths, or any
  driver-provided mount target;
- mountpoint has no symlink component at validation/mkdir time (`openat2` with
  `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, or equivalent fd-relative walk);
- mountpoint is empty before mounting;
- binary is an absolute path outside the writable workspace;
- binary and every parent component are root-owned and neither group- nor
  world-writable;
- binary is a regular executable and not a symlink;
- `fs_name` is nonempty, bounded, and contains only a conservative ASCII identifier
  character set;
- `args` have count and byte limits;
- `allow_other` defaults false; enabling it requires explicit policy and is not used
  by Openrind Shell v1;
- startup timeout is clamped to 1-120 seconds.

Validation opens the binary with `O_PATH | O_NOFOLLOW`, records device/inode metadata,
and revalidates immediately before `ProcessHandle` resolves the executable path. The
root-owned, non-writable parent-chain requirement removes the sandbox user's rename
race without introducing `fexecve`/`execveat`, which conflicts with the child seccomp
rules around fileless execution.

## 6. Supervisor Mount and Child Lifecycle

### 6.1 Privileged mount phase

Insert a `prepare_fuse_mounts()` phase in `run.rs` after
`prepare_filesystem_with_identity()` and before
`apply_supervisor_startup_hardening()`:

1. resolve and validate the static declarations;
2. create/open the mountpoint safely;
3. open `/dev/fuse` with `O_RDWR | O_CLOEXEC`;
4. issue the old FUSE mount API while mount is still permitted;
5. retain the FUSE fd and validated executable identity/path in a
   `PreparedFuseMount`;
6. do not start the daemon yet.

Mount flags:

```text
MS_NOSUID | MS_NODEV | MS_RELATIME
```

Mount data:

```text
fd=<actual_fd>,rootmode=40000,user_id=<sandbox_uid>,group_id=<sandbox_gid>,
default_permissions,max_read=1048576
```

Do not add `allow_other` for Openrind Shell. Do not set `MS_NOEXEC`: a coding workspace must
support package-manager scripts, project virtual environments, and compiled test
binaries. OpenShell's child seccomp, Landlock, process identity, and binary-attributed
network policy remain the execution boundary. `MS_NOSUID` prevents workspace files
from introducing setuid/setgid privilege transitions, and `MS_NODEV` prevents device
nodes from becoming active.

If any validation, open, or mount fails, fail supervisor startup. Never continue with
an empty local directory masquerading as the persistent workspace.

### 6.2 Explicit inherited-fd API

Extend `ProcessHandle::spawn` with a typed child-fd mapping, for example:

```rust
pub struct InheritedFd {
    pub source: OwnedFd,
    pub target: RawFd,
}
```

Rules:

- allocate target fds dynamically at or above a reserved floor, avoiding every fd
  already used by stdio, netns, prepared Landlock state, identity mounts, and other
  mappings;
- in `pre_exec`, use `dup3(source, target, 0)` or `fcntl(F_DUPFD, ...)` and clear
  `FD_CLOEXEC` on the target;
- close unrelated copies in the child and parent after successful spawn;
- mappings are supplied only by supervisor code, never parsed from user environment;
- expose target numbers through reserved environment such as
  `OPENSHELL_FUSE_FD_0`; strip any user-provided values for that namespace first;
- reject duplicate source/target mappings and target collisions;
- unit-test descriptor leakage by inspecting `/proc/<child>/fd`.

The daemon invocation is explicit and does not emulate `mount.fuse3` argv:

```text
/usr/local/bin/openrind-shell-fused serve
```

It reads `OPENSHELL_FUSE_FD_0` and claims that fd. This avoids `/dev/fd/N` path
parsing and hard-coded fd assumptions.

### 6.3 Spawn after hardening

After `apply_supervisor_startup_hardening()`, spawn the FUSE daemon through the same
`ProcessHandle` implementation as the workload, with:

- sandbox UID/GID;
- the normal network namespace;
- child `no_new_privs`, seccomp, and Landlock;
- proxy and TLS environment;
- no provider credentials unless a future design explicitly authorizes them;
- reserved FUSE fd and startup-readiness fd only;
- working directory `/` rather than the not-yet-ready FUSE mount.

Landlock preparation must allow the daemon binary, read-only runtime libraries and CA
files, `/tmp` or `/var/lib/openrind-shell/runtime`, and the database readiness file. It does
not need read/write access to `/dev/fuse`; it uses the inherited fd. The agent's
Landlock rules need access to `/sandbox/work` but not `/dev/fuse`.

### 6.4 Readiness handshake

Create a second supervisor-owned pipe or `eventfd` mapped into the daemon. The daemon
signals readiness only after:

1. `fuser::Session::from_fd` succeeds;
2. the FUSE INIT handshake completes;
3. its request loop is actively polling the fd.

The supervisor waits up to `startup_timeout_seconds`. On timeout or daemon exit, fail
startup. A mounted-but-unserved filesystem must never be reported Ready.

Database readiness is separate. The FUSE session can be healthy while Openrind Shell init
has not yet supplied credentials or completed migrations.

### 6.5 Critical-child behavior

Add explicit critical-child supervision rather than overloading the PID registry. The
main run loop selects over:

- normal workload exit;
- supervisor shutdown signal;
- FUSE daemon exit.

On FUSE daemon exit:

1. mark the supervisor terminating;
2. send SIGTERM to the workload and wait a short bounded interval;
3. SIGKILL the workload if needed;
4. emit a specific OCSF lifecycle failure naming the FUSE child and status;
5. exit the supervisor with a reserved critical-service status defined in
   `openshell-core`, for example `75` (`EX_TEMPFAIL`).

Do **not** call `umount2` or remount. The supervisor prelude correctly blocks those
operations. The FUSE-specific Docker `on-failure:5` policy recreates the container
process and mount namespace, which is the supported recovery boundary. Upstream
`unless-stopped` remains unchanged only for sandboxes that did not request FUSE.

On intentional supervisor shutdown, send SIGTERM to the daemon, allow up to 10
seconds for dirty-data flush, then kill it if necessary. Explicit `sandbox stop`
must use Docker's operator-stop path and remain stopped despite the FUSE container's
`on-failure` policy. Explicit `sandbox start` starts the retained container with a
fresh supervisor and mount namespace.

### 6.6 Gateway lifecycle fix

When a FUSE-labeled container is `RESTARTING`, report `ContainerRestarting`. When a
poll catches a nonzero `EXITED` state and Docker still has retry budget, report
`CriticalServiceRestarting` for the reserved status or `SandboxProcessRestarting` for
another supervisor failure. Add all three reasons to the gateway's transient failure
set. Once Docker exhausts five retries, report terminal
`CriticalServiceCrashLoop`/`SandboxProcessCrashLoop` according to the last status.
An unexpected zero exit and every non-FUSE generic `ContainerExited` remain terminal.
Explicit `sandbox start` must reset the retry budget before starting the container;
cover the Docker behavior with an integration test and use the Docker restart-policy
update API in the fenced start path if a plain manual start does not reset it.

Tests must prove:

- automatic Docker restart does not transition the public sandbox to terminal Error;
- phase is `Provisioning` or another nonterminal transitional phase while the
  supervisor session is absent;
- a fresh supervisor connection promotes the same sandbox back to Ready;
- the exited-before-Docker-restart snapshot remains transitional;
- another nonzero FUSE-supervisor failure restarts within the same bound;
- an unexpected zero FUSE exit and a non-FUSE generic `ContainerExited` remain
  terminal;
- the critical-service crash-loop budget eventually becomes Error;
- explicit stop becomes Stopped and does not oscillate through restart;
- explicit start returns through Starting/Provisioning to Ready.

Use the new upstream lifecycle event fences rather than creating a second restart
state machine.

## 7. Openrind Shell Daemon

### 7.1 New implementation boundary

Create a dedicated Rust binary installed as `openrind-shell-fused`. The Cargo package
and source directory remain `openeral-fused` for compatibility. It may reuse historical:

- fuser configuration patterns;
- inode/attribute conversion helpers;
- tests for `O_TRUNC`, rename identity, metadata-only reads, and Supabase typing;
- HTTP CONNECT behavior as a semantic reference from TypeScript.

It must not reuse wholesale:

- path-keyed whole-file `workspace_files` as the live schema;
- full-file per-handle buffers;
- split directory rename;
- daemon-owned Refinery migrations;
- direct `NoTls` PostgreSQL dialing;
- background session plus infinite `park`;
- the historical CSI/bootstrap runtime.

Prefer a new crate boundary such as:

```text
crates/openeral-fused/
  src/main.rs
  src/session.rs
  src/fs.rs
  src/handles.rs
  src/store/
    mod.rs
    postgres.rs
    schema.rs
    lease.rs
    operations.rs
  src/connect.rs
```

Keep the existing historical crates buildable until parity tests have been ported;
delete or archive them only in a later cleanup commit.

### 7.2 FUSE session lifecycle

Use foreground session execution or an explicit background-session `join` whose
result controls process exit. If the request loop stops, `main` must return nonzero so
OpenShell's critical-child path restarts the sandbox.

Recommended fuser settings:

- `DefaultPermissions`;
- no `AllowOther`;
- no `FUSE_WRITEBACK_CACHE`;
- enable `FUSE_ATOMIC_O_TRUNC`, `FUSE_ASYNC_READ`, and parallel directory operations
  only after conformance tests pass;
- cloned fd / bounded multi-thread request handling, 4-16 workers;
- conservative entry/attribute TTL initially (1 second), then benchmark-driven
  increases under the single-writer lease.

### 7.3 Database connection through OpenShell

The daemon must not dial PostgreSQL directly. Implement:

```text
tokio AsyncRead/AsyncWrite CONNECT stream
  -> OpenShell HTTP proxy from HTTPS_PROXY/http_proxy
  -> CONNECT db-host:db-port
  -> validate HTTP 200 with bounded headers and timeout
  -> tokio-postgres Config::connect_raw
  -> rustls PostgreSQL TLS connector
```

Requirements:

- parse the PostgreSQL URL with a maintained URL/parser type; do not hand-split;
- verify server certificates and hostname; no `NoTls`, `danger_accept_invalid_certs`,
  or `sslmode=disable` in the primary runtime;
- connect to the OpenShell proxy URL supplied in the child environment (normally
  plaintext HTTP on the private netns veth), and use the system/combined trust bundle
  for the target PostgreSQL TLS session;
- cap CONNECT response headers and timeouts;
- redact credentials and query strings from logs;
- use a small pool or multiplexed connection strategy compatible with concurrent
  FUSE workers;
- add `/usr/local/bin/openrind-shell-fused` to only the PostgreSQL network policy rule.

Force `synchronous_commit=on` for mutation and durability-barrier transactions. Reject
connection options that disable TLS or weaken certificate/hostname verification. A
successful fsync cannot be stronger than the target PostgreSQL service's committed
durability, but it must not be weakened by client session settings.

`deadpool-postgres` supports a custom connection manager, and `tokio-postgres` exposes
`connect_raw`; use those extension points rather than bypassing pool semantics.
The current upstream pin enforces `cargo-deny`; any new rustls, TLS-root, URL, or FUSE
dependency must pass its advisory, license, source, and duplicate-version policy.

### 7.4 Initialization coordination

Runtime control data lives outside the FUSE mount:

```text
/var/lib/openrind-shell/runtime/database-url      mode 0600
/var/lib/openrind-shell/runtime/database.ready    mode 0600, atomic rename
/var/lib/openrind-shell/runtime/init.done          mode 0600, atomic rename
/var/lib/openrind-shell/runtime/fused.sock         mode 0600
```

The Dockerfile creates this directory as `sandbox:sandbox`, mode 0700, and the static
filesystem policy grants that exact path read-write. Setup and daemon both run as the
sandbox UID and need to update it. Because Claude shares that UID in v1, these are
init-owned coordination files, not trusted supervisor state, authorization evidence,
or secret isolation. An agent can replace them and the Unix socket. Such replacement
may cause a fail-closed restart, but must never grant mount capability or bypass lease
fencing.

Before `database.ready` exists, each blocking namespace or data operation waits at
most five seconds for the state transition and then returns `EIO`. Do not return
`EAGAIN` for ordinary blocking regular-file operations. The management `health`
command returns immediately with `state=initializing`, and the daemon remains alive so
a late upload or retrying init does not create a container restart loop. Once the
marker appears, the daemon verifies its workspace ID, datasource hash, schema version,
and migration epoch, then connects and acquires the writer lease.

If an already-writable daemon observes a changed or missing marker, it stops accepting
mutations and follows the terminal fencing path in section 8.4. It must not carry dirty
state across an in-process datasource or epoch change. A clean datasource switch is an
init operation that first completes `flush-all`, removes both markers, and restarts the
container so a new daemon acquires a fresh epoch.

The Unix socket is the non-FUSE management channel. The same binary provides narrow
client subcommands:

```text
openrind-shell-fused health
openrind-shell-fused flush-all
```

`health` reports FUSE-loop, datasource hash, schema, lease owner/epoch, writable state,
dirty bytes, and last writeback error without revealing credentials. `flush-all`
snapshots every dirty inode, commits all data and required metadata through those
snapshots, and fails if any writeback error remains. This socket is an operational
interface only and is same-UID spoofable. Supervisor startup uses the inherited
readiness fd, and critical-child exit is observed through `ProcessHandle` waiting, so
replacing a filesystem path cannot satisfy startup readiness or hide process exit. A
future post-v1 hang watchdog requires a separate supervisor-owned heartbeat channel;
the management socket is not authoritative enough for that role.

## 8. PostgreSQL Filesystem Schema

### 8.1 Do not use `workspace_files` as the live filesystem

The current table is path-keyed and stores complete content in one row. It cannot
efficiently or safely provide stable inode identity, partial writes, atomic directory
rename, sparse data, and open-unlinked lifecycle. Keep it for compatibility/import,
not for live FUSE operations.

### 8.2 New tables

TypeScript migration V7 creates a new namespace without overloading old paths:

```sql
CREATE TABLE _openeral.fs_volumes (
  volume_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  root_node_id bigint NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);

CREATE TABLE _openeral.fs_nodes (
  volume_id text NOT NULL,
  node_id bigint GENERATED ALWAYS AS IDENTITY,
  kind smallint NOT NULL,
  mode integer NOT NULL,
  uid integer NOT NULL,
  gid integer NOT NULL,
  size bigint NOT NULL DEFAULT 0,
  nlink integer NOT NULL,
  atime_ns bigint NOT NULL,
  mtime_ns bigint NOT NULL,
  ctime_ns bigint NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  symlink_target bytea,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (volume_id, node_id),
  UNIQUE (node_id)
);

CREATE TABLE _openeral.fs_dirents (
  volume_id text NOT NULL,
  parent_node_id bigint NOT NULL,
  name bytea NOT NULL,
  child_node_id bigint NOT NULL,
  PRIMARY KEY (volume_id, parent_node_id, name),
  UNIQUE (volume_id, child_node_id)
);

CREATE TABLE _openeral.fs_chunks (
  volume_id text NOT NULL,
  node_id bigint NOT NULL,
  chunk_index bigint NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (volume_id, node_id, chunk_index)
);

CREATE TABLE _openeral.fs_mount_epochs (
  volume_id text PRIMARY KEY,
  epoch bigint NOT NULL,
  owner_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE _openeral.fs_operations (
  volume_id text NOT NULL,
  epoch bigint NOT NULL,
  operation_id uuid NOT NULL,
  request_hash bytea NOT NULL,
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (volume_id, epoch, operation_id)
);
```

The migration must add foreign keys and constraints that are omitted above for
readability:

- nodes/chunks/dirents cascade by volume;
- `fs_volumes.root_node_id` references a directory node through a deferred constraint
  so volume and root creation can commit atomically;
- dirent parent and child reference existing nodes;
- each non-root live node has at most one dirent because hard links are unsupported;
- chunk length is at most 256 KiB;
- names are nonempty, not `.`/`..`, contain no `/` or NUL, and are bounded to Linux
  name limits;
- sizes and link counts are nonnegative;
- node kind and symlink-target combinations are valid;
- indexes support parent listings, child lookup, orphan collection, and lease expiry.

Use 256 KiB chunks. Missing chunks represent sparse zero-filled holes. A truncate
transaction deletes chunks beyond EOF and zeroes the retained tail as required.

### 8.3 Stable identity and namespace operations

FUSE inode numbers derive from globally unique positive `node_id`, not paths. The
volume root is presented as the kernel-required `FUSE_ROOT_ID=1`; every non-root node
uses its database ID directly, with a per-volume assertion that no collision with 1 is
possible. Rename updates `fs_dirents` in a single serializable transaction and never
rewrites descendants. Replacement, cross-directory rename, `RENAME_NOREPLACE`, and
directory-cycle checks must be implemented in that transaction.

For a regular-file source with dirty data, that same transaction also persists the
source snapshot required by section 9.2 before changing either dirent. The rename's
operation ID covers the data snapshot, inode metadata, source move, and destination
replacement as one uncertain-outcome unit. A failed writeback leaves both namespace
entries unchanged.

Open-unlinked files remain in `fs_nodes` with `deleted=true` while an active daemon
handle exists. Handle counts are daemon memory, not persisted state; persisting them
would leak stale counts across a crash. Final release removes chunks and the node.
After daemon crash, the new mount's startup GC may reclaim every `deleted=true` node
because no old kernel handles can survive the reconstructed mount namespace.

### 8.4 Lease and fencing

Only one daemon may write a volume. Acquire a dedicated PostgreSQL advisory lock for
the daemon's session and increment `fs_mount_epochs.epoch` transactionally. Every
mutation transaction must:

1. lock the epoch row;
2. verify `owner_id`, epoch, and unexpired lease;
3. apply the filesystem change;
4. optionally record operation result;
5. commit.

Heartbeat the lease at a short interval on the same ownership identity. A renewal
error before the safety deadline pauses new mutations and starts bounded recovery; the
daemon may retain dirty bytes only while its existing lock session is alive and the
lease is still provably valid.

Loss of the advisory-lock session, expiry of the lease safety deadline, or a changed
datasource/epoch marker is a terminal fencing event. The daemon must atomically:

1. enter `Fenced` state and reject new mutations with `EIO` or `ESTALE`;
2. stop background writeback and prevent every old-epoch transaction from starting;
3. mark every inode with uncommitted dirty bytes with a persistent writeback error;
4. discard those dirty bytes without attempting to commit them under another epoch;
5. fail affected `write`, `flush`, `fsync`, `fdatasync`, and close-observable paths;
6. resolve already-submitted operations by operation ID where possible, without
   issuing replacement mutations;
7. exit with the reserved critical-child status after a short bounded error-delivery
   interval so Docker reconstructs the mount and a new daemon acquires a fresh epoch.

The fenced process never reacquires an epoch. Accepted data not covered by a completed
durability barrier may be lost at this boundary. Data covered by a successful `fsync`,
dirty-source rename, truncate-rewrite close barrier, or synchronous-I/O write was
already committed and remains durable. Old epochs can never mutate after a replacement
daemon is active.

### 8.5 Operation IDs and uncertain outcomes

Every database mutation gets a daemon-generated `operation_id` and canonical
`request_hash`. Store the result in `fs_operations` in the same transaction as the
mutation. If the PostgreSQL connection fails after submission and commit outcome is
unknown, reconnect and query the operation row under the original epoch before doing
anything else:

- row with matching hash: return stored result;
- no row and the original lease is still valid: retry with the same operation ID;
- no row after the lock session was lost or lease safety deadline expired: return
  `EIO`/`ESTALE`, record the writeback error, and follow terminal fencing; never replay
  the logical request under a new epoch;
- row with different hash: fail closed as an internal integrity error.

Garbage-collect operation rows after a conservative replay window once no request can
still be in flight. This provides deduplication for uncertain database outcomes; it
does not promise replay across a dead kernel mount or old epoch.

## 9. POSIX and Durability Contract

### 9.1 Required operations

v1 supports:

```text
lookup, forget, getattr, setattr, access
opendir, readdir, releasedir, fsyncdir
create, mkdir, open, read, write, flush, release
fsync, fdatasync, truncate, unlink, rmdir, rename
symlink, readlink, statfs
```

Required semantics:

- `O_TRUNC` and `FUSE_ATOMIC_O_TRUNC` truncate before open succeeds;
- partial and out-of-order writes are correct;
- reads through any handle in the same daemon observe accepted dirty writes according
  to normal close-to-open expectations;
- directory rename is atomic and inode identity remains stable;
- rename of a dirty regular-file source persists the captured source data before or
  atomically with the namespace change;
- unlink-open-file works until the final handle closes;
- `flush` may persist data and report prior writeback errors but is not the general
  durability API; closing a handle that rewrote a pre-existing file through `O_TRUNC`
  is the narrow exception defined below;
- `release` performs best-effort flush and cleanup but cannot return errors reliably to
  every caller;
- `fsync`/`fdatasync` commit all prior writes for that handle and report failure;
- `fsyncdir` succeeds only after all prior namespace mutations issued through the
  daemon have committed (those operations are synchronous in v1);
- `O_SYNC`/`O_DSYNC` writes do not return until the required commit completes;
- fake success is forbidden.

Return `ENOTSUP` for hard links, xattrs, advisory/mandatory locks, device/fifo/socket
nodes, unsupported `fallocate` modes, reflinks, and shared writable mmap until each is
implemented and tested. Cross-volume rename returns `EXDEV`.

### 9.2 Buffered write and safe-replacement policy

The general contract is durability on fsync, not commit on every write:

- keep one shared in-memory state object per inode; file handles reference that object
  rather than holding independent whole-file copies, so overlapping handles observe a
  coherent byte stream;
- assign a monotonic write sequence per inode. A flush snapshots dirty chunks and its
  highest sequence under the inode lock, releases the lock during PostgreSQL I/O, and
  clears only bytes still associated with the committed sequence; writes that race the
  flush remain dirty;
- acknowledge ordinary `write` after copying into the daemon's coherent dirty-chunk
  state;
- flush dirty chunks in the background every 250 ms;
- cap dirty data at 16 MiB per inode and 64 MiB globally;
- when a cap would be exceeded, synchronously flush enough dirty chunks or return a
  bounded error; never grow without limit;
- coalesce writes by chunk and generation;
- preserve the first asynchronous writeback error and report it on subsequent
  `flush`, `fsync`, and `close`-relevant operations;
- `fsync` captures the caller-visible sequence at entry and does not succeed until all
  file data and required metadata through that sequence commit; later concurrent
  writes may remain dirty;
- implement relatime-style atime updates and coalesce them with background metadata
  flushes; do not issue a PostgreSQL transaction for every read;
- keep a generation-fenced, per-mount read cache for inode metadata and authoritative
  directory snapshots. The first lookup in a directory may populate its full listing so
  both present and absent child probes remain local. Every committed namespace mutation
  increments the cache generation; a query started under an older generation may finish
  its in-flight request but must not repopulate stale cache state;
- namespace and metadata mutations (`create`, `mkdir`, `rename`, `unlink`, `rmdir`,
  symlink, chmod/chown/timestamp changes, truncate) commit before returning success;
- truncate serializes with the shared inode state so dirty chunks beyond the new EOF
  cannot be written back after the truncate transaction;
- do not enable kernel writeback cache in v1.

#### Dirty-source rename barrier

Any rename of a regular-file source with dirty data, whether or not it replaces an
existing destination, is a data-before-namespace barrier:

1. under the shared inode-state lock, capture source write sequence `S`, dirty chunk
   generations, size, and required metadata at rename entry;
2. in one serializable transaction, verify the lease and source/destination identities,
   persist source data and metadata through `S`, apply the source dirent move and any
   destination replacement, record the operation result, and commit;
3. after a known or operation-ID-resolved commit, clear only dirty bytes still
   associated with sequences through `S`; writes accepted after the snapshot remain
   dirty on the same inode at its new name.

If a prior writeback error exists or the transaction fails, return that error and do
not change either dirent. The old destination must never be removed before the source
snapshot is durable. After an uncertain crash-time outcome, recovery may expose the
old destination or the exact source state through `S`; it must never expose a missing,
empty, or partially persisted replacement. If rename returned success, the source
state through `S` and the namespace change are durable.

#### Replace-via-truncate close barrier

When an existing regular file is opened with `O_TRUNC` or
`FUSE_ATOMIC_O_TRUNC`, mark that open handle as a truncate rewrite. Every FUSE `FLUSH`
caused by closing that handle captures its current write sequence and synchronously
commits data and required metadata through that sequence. This is idempotent and runs
for each close associated with duplicated descriptors; later writes remain dirty until
a later close barrier or explicit durability call.

A failed barrier returns the writeback error from `FLUSH`, preserves the first error,
and prevents `release` from fabricating success. A successful close makes the rewrite
durable through the sequence captured by its `FLUSH`. A crash before any successful
close barrier may leave the already-committed truncation plus only data that an earlier
background flush happened to persist. Newly created files are not covered merely by
`O_TRUNC`; safe-save creation is protected when the dirty source is renamed.

These two rules intentionally model Linux ext4's
[`auto_da_alloc`](https://cdn.kernel.org/doc/html/latest/admin-guide/ext4.html)
protection for replace-via-rename and replace-via-truncate. They are explicit Openrind Shell
guarantees, not generic POSIX guarantees and not a replacement for applications using
`fsync` correctly.

A successful ordinary write can be lost if the daemon/container dies before a
background flush or a subsequent durability barrier completes. A successful `fsync`,
dirty-source rename through its captured sequence, or truncate-rewrite close barrier
cannot be lost within PostgreSQL's own committed-durability contract. Documentation
and tests must use exactly this language.

## 10. Openrind Shell Initialization and Runtime

### 10.1 Image and policy

Build the `openeral-fused` Cargo package in a Rust builder stage and copy a stripped
binary to `/usr/local/bin/openrind-shell-fused`. The runtime image does not install `fusermount`,
`fuse3`, or a setuid helper.

Set or verify the image workspace as `/sandbox`; do not set OCI `WORKDIR` to the FUSE
mountpoint. The one-shot init runs from `/sandbox`, and the Claude wrapper changes to
`/sandbox/work` only after `init.done` is valid.

Update `sandboxes/openeral/policy.yaml`:

- add the static `fuse_mounts` declaration;
- allow PostgreSQL endpoints for `/usr/local/bin/openrind-shell-fused`;
- retain `/usr/bin/node` temporarily because TypeScript init still performs migrations
  and legacy import; explicitly document that this means Claude, which shares the UID,
  can also invoke an authorized Node process against the permitted database endpoint;
- keep Claude, package registry, Git, Openrind Gateway, and provider policies unchanged;
- keep `/sandbox` writable in Landlock so `/sandbox/work` is accessible;
- do not expose `/dev/fuse` as a writable policy path to the agent.

Update structural lints to require the FUSE declaration and daemon binary while still
forbidding setuid helpers, `/etc/fuse.conf`, fstab mutation, privileged images, and
workload mount permissions.

### 10.2 One-shot `openrind-shell-init`

The trailing command remains one-shot and idempotent:

1. require and validate uploaded external `DATABASE_URL`;
2. store it at `/var/lib/openrind-shell/runtime/database-url` with mode 0600;
3. run TypeScript migrations, including V7;
4. acquire the volume/migration advisory lock;
5. create volume/root rows and run one-time legacy import if needed;
6. atomically write `database.ready` containing version, workspace ID, datasource
   hash, schema version, and completion timestamp;
7. wait up to 60 seconds for daemon health to report connected, leased, and writable;
8. independently query PostgreSQL and require the reported lease owner/epoch to match
   the current `fs_mount_epochs` row;
9. run the FUSE readiness probe described below;
10. verify the separate user-owned Claude home volume and configure Openrind Gateway
    without creating Claude onboarding, trust, settings, or skill defaults;
11. call `openrind-shell-fused flush-all` and require success;
12. atomically write `init.done` with the same identity fields plus completion time;
13. delete uploaded secret files;
14. exit 0.

The readiness probe creates a random 4 KiB canary below
`/sandbox/work/.openrind-shell/.init-probes/`, fsyncs the file and parent directory, reads
back and compares the exact bytes, unlinks the canary, and fsyncs the parent directory
again. Init removes stale probes from prior interrupted attempts. This proves the
mounted request path and durability barrier work together; the independent lease-row
check detects a stale or unrelated management socket. Neither check turns same-UID
state into an authorization boundary.

Before changing datasource identity, remove both markers. If migration/import fails,
never publish `database.ready`. If local-home or gateway configuration fails after
database readiness, leave `database.ready`, remove `init.done`, print a concrete
diagnostic, and exit nonzero so `--ensure` can resume. Do not fall back to PGlite or an
empty local project workspace.

If a failure occurs after `database.ready` but before `init.done`, the daemon remains
available and the next `openrind-shell init --ensure` resumes the idempotent
configuration steps. Publishing `init.done` is the product-ready barrier. The
supervisor's FUSE readiness means only that the kernel session is served.

### 10.3 Legacy data import

Avoid mapping historical `/.claude` rows directly into the new root because old
workspace rows may contain unrelated paths and prefix collisions. V7 records an
explicit import marker per workspace.

On first init only:

- import `/.claude/**` to `/sandbox/work/.claude/**`;
- import `/.claude.json` to `/sandbox/work/.claude.json`;
- import `/.openeral/**` to `/sandbox/work/.openeral/**`;
- do not import arbitrary old `/src` or `/` rows without an explicit migration flag;
- preserve modes and timestamps where valid;
- perform import transactionally or in restartable batches with a completion marker;
- never delete legacy rows during the first release.

Subsequent init runs do not seed Claude-owned defaults or overwrite user content.

### 10.4 Claude wrapper

The primary wrapper becomes simpler:

```text
export HOME=/sandbox/claude-home
cd /sandbox/work when invoked from /sandbox or /
run openrind-shell init --ensure; require matching init.done
verify openrind-shell-fused health is writable
run claude-real as a child with signal forwarding
on clean exit call openrind-shell-fused flush-all and wait for completion
return Claude's status
```

Remove the compatibility daemon-ensure helper, scoped watcher startup, marker-gated
hydration, and Node compatibility-daemon flush from the primary FUSE image. The `pg` helper can use the
existing TypeScript database client or a daemon IPC query command, but it must not
start a second persistence daemon.

### 10.5 Compatibility packaging

Keep current scoped-sync/PGlite behavior available as a separately named legacy image
or development mode during rollout. Do not silently switch one tag between the two
architectures. The published primary FUSE tag must fail clearly on an unpatched
OpenShell gateway or a non-Docker driver.

The just-bash library API and `PgFs` remain supported for custom agents; they are not
part of the FUSE mount.

## 11. Security Model

### Preserved controls

- Claude cannot call mount or unmount.
- `/dev/fuse` is injected only for an operator-enabled, explicitly requested sandbox.
- mountpoints and binaries are immutable policy, validated before exposure.
- daemon runs as sandbox UID with normal Landlock, seccomp, netns, and proxy controls.
- raw database egress is rejected; daemon and init-time Node CONNECT traffic is
  limited to policy-declared PostgreSQL endpoints and attributed binaries.
- PostgreSQL TLS is end-to-end.
- no host filesystem path or volume plugin is added.

### Accepted v1 limitation

Claude and `openrind-shell-fused` share a UID. Claude can signal the daemon and may inspect
same-UID runtime state, including the database URL. Because Node remains authorized
for TypeScript migrations in v1, the agent can also use Node to reach the same
policy-declared PostgreSQL endpoint. Killing the daemon causes the sandbox to restart,
but that is an availability response, not secret isolation. OpenShell still mediates
the destination and binary; database least privilege/RLS must limit the consequence of
credential exposure.

Do not claim NemoClaw-style gateway/agent privilege separation in v1. A future phase
may add a storage service UID, protected config, and supervisor-mediated secret fd,
but that requires a separate policy/process design.

## 12. Failure Semantics

| Failure | Required result |
|---|---|
| Database URL not uploaded | FUSE session remains alive but unavailable; init fails clearly; no PGlite fallback. |
| Operation before database readiness | Wait at most five seconds, then return `EIO`; health remains immediately available as `initializing`. |
| PostgreSQL temporarily unavailable before lease safety deadline | Pause mutations and retry within a bound; preserve dirty data only while ownership remains provable. |
| Lease session lost, safety deadline expired, or stale epoch | Enter terminal fencing, discard uncommitted dirty data with writeback errors, never reacquire in-process, and exit for container restart. |
| Same-UID marker/socket replacement | Treat as untrusted coordination failure; reject mismatched identity or fence/restart. It cannot satisfy supervisor startup readiness. |
| DB commit outcome unknown | Resolve by operation ID before retry or reply. |
| Crash during dirty-source rename | Namespace is either the complete pre-rename state or complete post-rename state with exact source data through captured sequence `S`; a replaced destination is never missing, empty, or partial. A successful rename always yields the post-rename state. |
| Crash during existing-file `O_TRUNC` rewrite | Before a successful close barrier, committed truncation and partial background writeback are allowed; after successful close, data through its captured sequence survives. |
| FUSE event loop exits | Daemon exits nonzero; supervisor kills workload and exits; Docker restarts sandbox. |
| Daemon is SIGKILLed by Claude | Same critical-child restart path. Dirty data not covered by a completed durability barrier may be lost. |
| Daemon hangs (post-v1 target) | A future supervisor-owned heartbeat watchdog terminates it and enters the critical-child restart path. |
| Explicit `sandbox stop` | Daemon gets bounded graceful flush; container stops and stays stopped. |
| `sandbox start` | New supervisor remounts; daemon reconnects/leases; sandbox returns Ready. |
| Forced sandbox delete | Committed data survives; dirty writes not covered by a completed durability barrier may be lost. |
| Second sandbox uses same workspace | Writer lease/fencing prevents concurrent mutation; second init fails or mounts read-only by future policy, never split-brain. |

V1 bounds database and request failure paths while the daemon event loop remains
responsive, but does not claim automatic recovery from an arbitrary alive-but-deadlocked
daemon. Operator `sandbox stop`/`sandbox start` is the v1 recovery. A post-v1 watchdog
must use a separate inherited, supervisor-owned heartbeat channel and must kill the
daemon to enter the existing critical-child restart path. Do not trust the same-UID
management socket or probe a path through a potentially hung filesystem. The Linux
[FUSE documentation](https://www.kernel.org/doc/html/latest/filesystems/fuse/fuse.html)
describes daemon termination or explicit connection abort as the reliable way to
release hung requests.

## 13. Verification Plan

### 13.1 OpenShell unit tests

- proto/API resource mapping round trips public -> server -> driver;
- CLI `--fuse` parsing and SDK helper construction;
- Docker gate default-off, host-device absence, and device mapping;
- unsupported-driver rejection;
- policy YAML parse/serialize and unknown-field behavior;
- static policy update rejection;
- mountpoint/binary validation, symlink race defense, and control-path overlap;
- reject `/sandbox/work` as both OCI workspace root and FUSE mountpoint;
- inherited-fd remapping, CLOEXEC clearing, collision rejection, and no leakage;
- child receives sandbox UID, netns, Landlock, seccomp, proxy, and TLS environment;
- daemon readiness timeout and early-exit handling;
- pre-database blocking operations time out with `EIO`, never `EAGAIN`;
- replacing the same-UID marker or health socket cannot satisfy the inherited
  startup-readiness channel;
- critical child exit terminates workload and supervisor nonzero;
- `ContainerRestarting` is transient and reconnect returns Ready;
- five consecutive failures exhaust the FUSE restart budget and become terminal;
- explicit stop remains stopped and explicit start resets the retry budget;
- `cargo deny check` remains green with every new dependency.

### 13.2 OpenShell Docker E2E

Use a tiny hello-FUSE image and real Docker gateway:

1. unrequested sandbox has no changed behavior;
2. disabled gate rejects `--fuse`;
3. one-shot init starts from `/sandbox` before database readiness;
4. requested sandbox exposes a served file at its declared mountpoint;
5. agent cannot mount another FUSE filesystem or access the raw device meaningfully;
6. kill daemon, observe container restart, reconnect, and read the mount again;
7. stop remains Stopped; start remounts and returns Ready;
8. bad policy or binary fails before Ready;
9. five rapid critical failures become a terminal crash loop;
10. a manual start after the crash loop resets the budget and can return Ready;
11. no supervisor/control fd leaks into daemon or workload.

### 13.3 Filesystem conformance

Run against local PostgreSQL and live Supabase:

- unit tests for chunk reads/writes, sparse holes, truncate tails, mode/time updates;
- randomized partial/out-of-order I/O against a local reference filesystem;
- stable inode across rename;
- atomic file and directory rename, replacement, no-replace, and cycle rejection;
- dirty-source rename, both replacing and non-replacing, commits the captured source
  sequence and namespace mutation atomically;
- dirty-source rename fault injection before database writes, after chunk statements
  but before transaction commit, after commit with the response lost, and immediately
  after a successful reply yields only the complete pre-rename or complete post-rename
  state, never a missing, empty, or partial replacement;
- failed dirty-source rename writeback leaves source and destination dirents unchanged;
- writes accepted after a rename snapshot sequence remain dirty on the renamed inode
  and cannot change or corrupt the sequence committed by the rename;
- closing an existing-file `O_TRUNC` rewrite without explicit `fsync` commits through
  the sequence captured by `FLUSH`, survives immediate daemon/container restart, and
  reports synchronous writeback failures;
- duplicated descriptors and repeated `FLUSH` requests make the `O_TRUNC` close barrier
  idempotent while preserving later writes, and a crash before any successful close
  remains limited to the documented committed-truncation/partial-write state;
- unlink-open-file and crash-time orphan GC;
- concurrent handles with coherent dirty state;
- async writeback error propagation;
- `fsync`, `fdatasync`, `O_SYNC`, and `O_DSYNC` durability;
- operation-ID resolution after simulated commit/response loss;
- lease expiry, stale epoch rejection, and second-writer fencing;
- dirty-cache lease loss discards old-epoch bytes, reports writeback errors, and never
  flushes or replays them under a new epoch;
- a renewal error before the safety deadline pauses writes without prematurely
  discarding still-owned dirty data;
- malformed names, symlinks, permissions, and unsupported operation errno tests;
- Supabase parameter typing regression from `ccc278b`;
- event-loop failure exits process instead of parking.

Use a suitable subset of pjdfstest plus `fsx`/`fio`-style randomized I/O. Unsupported
tests must fail with the documented errno, not be silently skipped.

### 13.4 Real product E2E

With the actual patched OpenShell Docker gateway, published-style Openrind Shell image,
Supabase URL, and real Claude credentials:

1. create with `--fuse`, uploaded DB URL, and `-- openrind-shell-init`;
2. connect and verify `HOME` and cwd are `/sandbox/work`;
3. verify init's lease cross-check and create/fsync/read/unlink canary completed before
   `init.done` appeared;
4. run real Claude Code and have it create project files and memory/settings state;
5. cleanly exit Claude and verify `flush-all`/`fsync` completion;
6. stop/start the same sandbox and verify all state;
7. delete/recreate with the same workspace ID and verify restoration from PostgreSQL
   without scoped hydration;
8. verify Git clone/status/commit, npm install/test, compiler output, symlinks, and
   Claude continuation;
9. verify no watcher process and no writes to legacy `workspace_files` after import;
10. replace the same-UID marker/socket and verify fail-closed behavior without a false
    supervisor startup-readiness signal;
11. kill the daemon mid-session, observe automatic restart and public phase recovery;
12. prove fsynced writes survive and explicitly demonstrate that an ordinary write
    without any completed durability barrier may be lost under forced failure;
13. exercise the safe-save pattern without explicit `fsync`: write a dirty temporary
    file, rename it over an existing Claude settings file, kill the daemon immediately
    after rename returns, and verify restart exposes the exact replacement bytes;
14. exercise replace-via-truncate without explicit `fsync`: open an existing Claude
    settings file with `O_TRUNC`, rewrite and close it, kill the daemon immediately
    after close returns, and verify restart exposes the exact bytes.

### 13.5 Performance gates

Before changing the published default, record local-disk/scoped-sync and FUSE results
for:

- Claude startup to first prompt;
- `git status` on 1k, 10k, and 100k file trees;
- npm/pnpm install and test on a representative project;
- metadata operations per second;
- 4 KiB random write latency before and during fsync;
- dirty-source rename barrier latency with 4 KiB, 1 MiB, and 16 MiB of dirty source
  data, measured separately for replacing and non-replacing rename;
- existing-file `O_TRUNC` rewrite close-barrier latency for the same representative
  sizes, including duplicated-descriptor `FLUSH` overhead;
- sequential read/write throughput;
- PostgreSQL transactions and bytes per workload;
- restart-to-Ready recovery time.

Initial release gate: no correctness failures or indefinite waits in supported v1
database, I/O, and restart fault scenarios; arbitrary alive-but-deadlocked daemon
recovery remains the documented post-v1 watchdog limitation. P95 Claude startup and
`git status` must be no worse than 2x the scoped-sync baseline on the documented
Supabase deployment; durability-barrier latency and throughput are published rather
than hidden.

## 14. Source Ownership, Upstream Footprint, and Fallback

### 14.1 Vendored OpenShell pin

Implementation uses a plain source snapshot at `vendor/openshell/`, without a nested
`.git` directory, pinned initially to
`c4b500a7de64d0b66e3ee8098f58d14299092162`. The committed
`vendor/openshell/UPSTREAM` contains:

```text
repository=https://github.com/NVIDIA/OpenShell.git
commit=c4b500a7de64d0b66e3ee8098f58d14299092162
tree=30d1825d5be2a631823d941188803e29f09aedd5
fetched_at=2026-08-14
```

Keep the pristine source identity and Openrind Shell patch reviewable when rebasing. Commit generated SDK/API
artifacts when OpenShell's normal generation workflow requires them. Put Rust targets,
tool caches, generated scratch directories, and image-build outputs in the repository
`.gitignore`; never hide them through selective commit behavior.

To verify the pristine import, clone the recorded repository, confirm both commit and
tree IDs, export that commit with `git archive`, and compare it recursively against
`vendor/openshell/` while excluding only `UPSTREAM` and paths named in `.gitignore`.

### 14.2 Expected upstream size

This is not a 300-line supervisor tweak. As reference points in the pinned history,
the GPU resource-request change `2c545893` touched 22 files with 2,035 insertions, and
the stop/start lifecycle change `0f8fad23` touched 69 files with 5,034 insertions,
including generated output. FUSE spans both resource propagation and lifecycle plus
policy, fd inheritance, mount setup, and critical-child supervision.

Use a planning envelope of 30-60 handwritten files and 3,000-6,000 non-generated
changed lines for the OpenShell patch, including tests and docs, plus normal generated
SDK/API artifacts. This is an estimate, not a target to game. At the Phase 1 exit,
record changed files, non-generated line count, generated line count, new dependencies,
and driver-specific code. If the handwritten patch exceeds the envelope, split the
upstream work into independently default-off resource/policy/driver and
supervisor/lifecycle PRs before starting the Openrind Shell storage implementation.

Measured implementation footprint against the pristine `UPSTREAM` archive, excluding
`target`, `node_modules`, and the provenance file: 42 handwritten/source/doc paths
with 1,576 insertions and 61 deletions, plus 6 generated Go/TypeScript proto paths with
10,512 insertions and 1,157 deletions. No OpenShell Cargo manifest or lockfile changed.
Driver-specific code enables Docker and adds explicit rejection to Podman, Kubernetes,
and VM; the remaining changes are public API, policy, supervisor, gateway lifecycle,
SDK conversion, tests, and documentation.

### 14.3 Acceptance and fallback

- If upstream accepts the capability, require the first released OpenShell version
  containing it, validate migration from the vendored build, and remove the vendor
  patch after one compatibility release.
- While upstream review is pending, build gateway, CLI, and supervisor artifacts from
  the pinned vendor tree and label the FUSE runtime experimental.
- If upstream rejects the capability, keep the bounded vendor patch with its source
  pin and security tests. Do not silently replace the first-class API with a private
  `driver_config` escape hatch.
- If filesystem correctness, real-Claude, restart, or performance gates fail, do not
  promote the FUSE image. Keep scoped sync as the stable default and publish the failed
  gate rather than weakening OpenShell security controls.
- If a newer OpenShell revision materially changes mount ordering, process hardening,
  or lifecycle state, rebase the pristine vendor snapshot first and rerun Phase 1
  before carrying the Openrind Shell patch forward.

### 14.4 Paste-ready upstream proposal

```text
Title: First-class, policy-gated FUSE resources for Docker sandboxes

Problem
OpenShell can attach existing volumes, but it cannot safely run an image-provided
FUSE filesystem. Passing /dev/fuse alone is insufficient: sandbox workloads cannot
mount under the current seccomp/no-new-privs model, and granting mount capability to
the agent would weaken the security boundary. The supervisor also applies a TSYNC
mount-denying prelude before workloads start, so daemon crash recovery cannot remount
in place.

Proposal
Add an optional `--fuse` resource requirement and immutable `fuse_mounts` image-policy
declaration. For operator-enabled Docker drivers only, inject /dev/fuse. The supervisor
validates and mounts before its seccomp prelude, then launches the declared daemon
after hardening through ProcessHandle with explicit inherited fd mappings. Treat the
daemon as a critical child; its exit terminates the supervisor and bounded Docker
on-failure restart reconstructs the mount namespace. Unsupported drivers reject the
request explicitly.

Security properties
The feature is default-off at the driver and request layers. Claude receives neither
/dev/fuse nor mount capability. The daemon runs as the sandbox UID with existing
Landlock, seccomp, netns, proxy, and TLS controls. Mountpoint and executable paths are
static, root-owned policy. No privileged, setuid, in-place remount, or user-controlled
fd path is introduced.

Required lifecycle work
Add explicit inherited-fd mappings, a supervisor-owned FUSE INIT readiness channel,
critical-child waiting, FUSE-specific on-failure:5 policy, and transient gateway state
for Docker RESTARTING and the pre-restart EXITED snapshot. Explicit stop must remain
Stopped; start must reset the retry budget and reconstruct the mount.

Acceptance
Stock sandboxes are byte-for-byte behaviorally unchanged. Unit and Docker E2E tests
cover disabled/unsupported rejection, policy validation, descriptor non-leakage,
child hardening, served mount readiness, daemon crash/recovery, crash-loop exhaustion,
and explicit stop/start. No agent mount permission is added.
```

## 15. Implementation Sequence And Status

### Phase 0: Preserve evidence — complete

- land these documents;
- record the OpenShell pin and source checks;
- import the pristine OpenShell pin at `vendor/openshell/` with `UPSTREAM` metadata and
  repository-wide ignore rules for build artifacts;
- port historical correctness tests into a neutral test inventory before changing
  old Rust code.

### Phase 1: OpenShell hello-FUSE patch — implemented and locally verified

- public/driver proto and CLI/SDK propagation;
- Docker operator gate and device mapping;
- static `fuse_mounts` policy;
- safe validation and pre-prelude mount;
- explicit inherited-fd spawn API;
- readiness handshake and critical-child wait;
- gateway restart-state fix;
- hello-FUSE unit and Docker E2E.

The implemented mount survives daemon exit through container reconstruction with no
workload mount permission. Retry exhaustion and the explicit stop/start matrix remain
rollout checks; record the final measured upstream patch footprint before submission.

### Phase 2: PostgreSQL storage core — implemented

- V7 normalized FUSE schema plus the V8 renamed-compatibility bridge;
- TypeScript-only migration/seed/import flow;
- Rust CONNECT + rustls pool;
- lease/fencing and operation resolution;
- inode/dirent/chunk store and conformance tests.

### Phase 3: FUSE daemon — implemented

- inherited-fd session/readiness;
- required POSIX operations;
- bounded dirty cache and fsync contract;
- health channel, foreground lifecycle, and fault injection.

### Phase 4: Sandbox integration — implemented

- Dockerfile, policy, setup/init, Claude wrapper, skills, README, and architecture;
- remove watcher/daemon-ensure from primary runtime;
- explicit compatibility image/tag for scoped sync;
- legacy state import.

### Phase 5: Real Claude and rollout — in progress

- live Supabase and Claude E2E;
- durability/restart/fencing fault matrix;
- benchmark gates;
- upstream OpenShell PR with docs, security analysis, and tests;
- publish only after a clean recreate-from-PostgreSQL run.

## 16. Files Expected to Change

### OpenShell

The following paths are relative to `vendor/openshell/`; `UPSTREAM` is maintained at
that root:

```text
UPSTREAM
proto/openshell.proto
proto/compute_driver.proto
proto/sandbox.proto
crates/openshell-cli/**
crates/openshell-sdk/**
python/**
sdk/{go,typescript}/**
fern/**
crates/openshell-server/src/compute/**
crates/openshell-server/src/grpc/validation.rs
crates/openshell-gateway-interceptors/**
crates/openshell-driver-docker/**
crates/openshell-driver-{podman,kubernetes,vm}/**  # explicit rejection
crates/openshell-policy/**
crates/openshell-core/src/policy.rs
crates/openshell-supervisor-process/src/{run,process,managed_children}.rs
docs/reference/{policy-schema,sandbox-compute-drivers}.mdx
docs/sandboxes/manage-sandboxes.mdx
e2e/rust/**
generated SDK/API artifacts
```

### Openrind Shell

```text
.gitignore                                        # vendored build artifacts
Dockerfile.openrind-shell                         # canonical primary image
Dockerfile.openrind-shell-compat                  # canonical compatibility image
crates/openeral-fused/**                          # Cargo package, installed under public name
openeral-js/src/db/migrations.ts                  # V7, sole migration owner
openeral-js/src/db/fuse-init.ts                   # init/import/admin
sandboxes/openeral/{Dockerfile,policy.yaml,setup-fuse.sh}
sandboxes/openeral/openeral-claude-fuse.sh
crates/openeral-fused/src/management.rs            # health and flush subcommands
tests/fuse/** and live E2E scripts
README.md
ARCHITECTURE.md
BUILD.md
.claude/skills/openrind-{dev,shell,navigate}/SKILL.md
openeral-js/lint.mjs
```

The current watcher files may remain for the compatibility image/library path, but
the primary FUSE sandbox must not invoke them.

## 17. Rejected Shortcuts

- **Only pass `/dev/fuse` through:** workload seccomp/no-new-privs still prevents
  mount and would tempt a security regression.
- **Allow `mount` for Claude:** breaks the intended OpenShell boundary.
- **Start daemon before supervisor hardening:** gives it excess privilege.
- **Assume fd 3:** unsafe in a multicomponent supervisor.
- **Restart daemon and remount in place:** supervisor prelude blocks mount/umount;
  existing open fds cannot be repaired anyway.
- **Keep watcher for `.claude` while FUSE stores project files:** creates two
  persistence authorities and ordering bugs for settings and memory.
- **Reuse `workspace_files` live:** path identity, whole-row writes, rename, sparse,
  and open-unlinked semantics are inadequate.
- **Let Rust daemon run migrations:** reintroduces migration races and schema drift.
- **Use PostgreSQL `NoTls` or direct sockets:** fails both security and OpenShell
  egress requirements.
- **Use host service expose/ForwardTcp in this design:** unnecessary extra network and
  reliability layer; retained only as the no-fork alternative in FUSE.md.
- **Claim same-UID credential isolation:** false.
- **Commit rename replacement before dirty source data:** can durably remove the old
  destination while leaving an empty or partial replacement after a crash.
- **Claim all successful writes are durable:** false under the selected buffered-write
  contract.

## 18. Completion Criteria

The design is implemented only when all of the following are true:

- stock behavior is unchanged when FUSE is not requested;
- unpatched/disabled/unsupported configurations fail clearly;
- `/sandbox` remains the bootstrap workspace root, `/sandbox/work` becomes Claude's
  cwd after successful init, and `/sandbox/claude-home` is Claude's home;
- Claude cannot mount, unmount, or bypass OpenShell database egress policy;
- the daemon receives the intended inherited fd and full child sandboxing;
- same-UID marker/socket replacement cannot satisfy supervisor startup readiness or
  bypass lease identity checks;
- pre-database filesystem operations return bounded `EIO`, never hang or return
  inappropriate blocking-path `EAGAIN`;
- a daemon crash causes bounded sandbox restart and returns public state to Ready;
- explicit stop/start works and does not trigger an unintended restart loop;
- normalized schema passes filesystem conformance and uncertain-commit tests;
- a fenced daemon never flushes, retries, or replays old dirty data under a new epoch;
- fsynced writes survive every tested daemon/container/sandbox recreation;
- every successful dirty-source rename survives immediate daemon/container restart
  with the exact source state through its captured sequence and atomic namespace state;
- every successful close barrier for an existing-file `O_TRUNC` rewrite survives
  immediate daemon/container restart with the exact data through its captured sequence;
- ordinary-write loss outside any completed durability barrier matches the documented
  contract;
- no legacy watcher participates in primary persistence;
- real Claude Code runs with `HOME=/sandbox/claude-home`, exits, restarts, continues,
  and survives sandbox container replacement on the same Docker daemon; project files
  independently survive through PostgreSQL FUSE;
- all OpenShell and Openrind Shell unit, integration, lint, and E2E suites are green;
- the vendored source pin, patch footprint, generated artifacts, and upstream/fallback
  status are recorded reproducibly;
- benchmark results and accepted limitations are published in the user and developer
  documentation.

Until these criteria pass, FUSE remains experimental and the scoped-sync image remains
the stable compatibility route.
