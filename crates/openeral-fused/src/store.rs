use crate::connect::{connect, ConnectedDatabase};
use crate::error::{Error, Result};
use crate::model::{
    now_ns, ChunkWrite, DataSnapshot, DirectoryEntry, Node, NodeKind, FUSE_ROOT_INODE,
    SCHEMA_VERSION,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio_postgres::{Client, IsolationLevel, Row, Transaction};
use uuid::Uuid;

const LEASE_SECONDS: i64 = 15;

pub struct PgStore {
    client: Mutex<Client>,
    connection_error: parking_lot::Mutex<tokio::sync::watch::Receiver<Option<String>>>,
    database_url: String,
    volume_id: String,
    workspace_id: String,
    root_node_id: i64,
    owner_id: Uuid,
    epoch: i64,
    terminal_fence: tokio::sync::watch::Sender<Option<String>>,
}

struct PendingOperation {
    id: Uuid,
    request_hash: [u8; 32],
}

impl PendingOperation {
    fn new(parts: &[&[u8]]) -> Self {
        Self {
            id: Uuid::new_v4(),
            request_hash: operation_hash(parts),
        }
    }
}

impl PgStore {
    pub async fn open(
        connected: ConnectedDatabase,
        database_url: String,
        workspace_id: String,
        uid: u32,
        gid: u32,
    ) -> Result<Self> {
        let mut client = connected.client;
        let volume_id = format!("workspace:{workspace_id}");
        let root_node_id = ensure_volume(&mut client, &volume_id, &workspace_id, uid, gid).await?;
        let acquired: bool = client
            .query_one(
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0))",
                &[&volume_id],
            )
            .await
            .map_err(|error| Error::database("acquiring the filesystem advisory lock", error))?
            .get(0);
        if !acquired {
            return Err(Error::Fenced);
        }
        let owner_id = Uuid::new_v4();
        let epoch: i64 = client
            .query_one(
                "INSERT INTO _openeral.fs_mount_epochs
                   (volume_id, epoch, owner_id, lease_expires_at, updated_at)
                 VALUES ($1, 1, $2, NOW() + ($3::bigint * INTERVAL '1 second'), NOW())
                 ON CONFLICT (volume_id) DO UPDATE
                   SET epoch = _openeral.fs_mount_epochs.epoch + 1,
                       owner_id = EXCLUDED.owner_id,
                       lease_expires_at = EXCLUDED.lease_expires_at,
                       updated_at = NOW()
                 RETURNING epoch",
                &[&volume_id, &owner_id, &LEASE_SECONDS],
            )
            .await
            .map_err(|error| Error::database("creating the filesystem writer lease", error))?
            .get(0);
        let (terminal_fence, _) = tokio::sync::watch::channel(None);

        Ok(Self {
            client: Mutex::new(client),
            connection_error: parking_lot::Mutex::new(connected.connection_error),
            database_url,
            volume_id,
            workspace_id,
            root_node_id,
            owner_id,
            epoch,
            terminal_fence,
        })
    }

    #[must_use]
    pub fn volume_id(&self) -> &str {
        &self.volume_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn owner_id(&self) -> Uuid {
        self.owner_id
    }

    #[must_use]
    pub fn epoch(&self) -> i64 {
        self.epoch
    }

    pub fn db_node_id(&self, fuse_inode: u64) -> Result<i64> {
        if fuse_inode == FUSE_ROOT_INODE {
            Ok(self.root_node_id)
        } else {
            i64::try_from(fuse_inode)
                .map_err(|_| Error::Invalid("inode exceeds PostgreSQL bigint".into()))
        }
    }

    #[must_use]
    pub fn fuse_inode(&self, node_id: i64) -> u64 {
        if node_id == self.root_node_id {
            FUSE_ROOT_INODE
        } else {
            node_id as u64
        }
    }

    pub fn connection_failed(&self) -> Option<String> {
        self.connection_error.lock().borrow().clone()
    }

    /// Replace a lost PostgreSQL connection while the writer lease is still
    /// provably ours. Opens a fresh connection, re-takes the session-level
    /// advisory lock, verifies the lease row (same owner and epoch, unexpired),
    /// renews it, and only then swaps the live client. Any lease mismatch is
    /// terminal (`Error::Fenced`); connection-level failures are retryable by the
    /// caller within the lease safety window.
    pub async fn reconnect(&self) -> Result<()> {
        let connected = connect(&self.database_url).await?;
        let acquired: bool = connected
            .client
            .query_one(
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0))",
                &[&self.volume_id],
            )
            .await?
            .get(0);
        if !acquired {
            return Err(Error::Internal(
                "writer advisory lock is still held by the previous session".into(),
            ));
        }
        let renewed = connected
            .client
            .execute(
                "UPDATE _openeral.fs_mount_epochs
                    SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 second'),
                        updated_at = NOW()
                  WHERE volume_id = $1 AND owner_id = $2 AND epoch = $3
                    AND lease_expires_at > NOW()",
                &[&self.volume_id, &self.owner_id, &self.epoch, &LEASE_SECONDS],
            )
            .await?;
        if renewed != 1 {
            return Err(Error::Fenced);
        }
        *self.client.lock().await = connected.client;
        *self.connection_error.lock() = connected.connection_error;
        Ok(())
    }

    pub fn subscribe_terminal_fence(&self) -> tokio::sync::watch::Receiver<Option<String>> {
        self.terminal_fence.subscribe()
    }

    fn request_terminal_fence(&self, reason: impl Into<String>) {
        self.terminal_fence.send_replace(Some(reason.into()));
    }

    pub async fn heartbeat(&self) -> Result<()> {
        if let Some(error) = self.connection_failed() {
            // A dead connection is not a lost lease: the caller reconnects and
            // re-verifies ownership within the lease safety window.
            return Err(Error::Internal(format!(
                "PostgreSQL connection lost: {error}"
            )));
        }
        let client = self.client.lock().await;
        let updated = client
            .execute(
                "UPDATE _openeral.fs_mount_epochs
                    SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 second'),
                        updated_at = NOW()
                  WHERE volume_id = $1 AND owner_id = $2 AND epoch = $3
                    AND lease_expires_at > NOW()",
                &[&self.volume_id, &self.owner_id, &self.epoch, &LEASE_SECONDS],
            )
            .await?;
        if updated != 1 {
            return Err(Error::Fenced);
        }
        Ok(())
    }

    async fn commit_operation(
        &self,
        tx: Transaction<'_>,
        operation: &PendingOperation,
    ) -> Result<()> {
        match tx.commit().await {
            Ok(()) => Ok(()),
            Err(error) if error.code().is_some() => {
                Err(Error::database("committing a filesystem operation", error))
            }
            Err(commit_error) => {
                let reason = format!(
                    "database commit response was lost for operation {}: {commit_error}",
                    operation.id
                );
                match self.resolve_operation(operation).await {
                    Ok(true) => {
                        // The mutation is durable, so its FUSE reply may succeed. The
                        // advisory-lock session is no longer trustworthy, however,
                        // and this daemon must not accept another mutation.
                        self.request_terminal_fence(reason);
                        Ok(())
                    }
                    Ok(false) => {
                        self.request_terminal_fence(reason);
                        Err(Error::Fenced)
                    }
                    Err(resolve_error) => {
                        self.request_terminal_fence(format!(
                            "{reason}; operation resolution failed: {resolve_error}"
                        ));
                        Err(Error::Fenced)
                    }
                }
            }
        }
    }

    async fn resolve_operation(&self, operation: &PendingOperation) -> Result<bool> {
        let connected = connect(&self.database_url).await?;
        let row = connected
            .client
            .query_opt(
                "SELECT request_hash FROM _openeral.fs_operations
                  WHERE volume_id = $1 AND epoch = $2 AND operation_id = $3",
                &[&self.volume_id, &self.epoch, &operation.id],
            )
            .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let stored_hash: Vec<u8> = row.get(0);
        if stored_hash.as_slice() != operation.request_hash {
            return Err(Error::Internal(
                "operation journal request hash mismatch".into(),
            ));
        }
        Ok(true)
    }

    pub async fn get_node(&self, node_id: i64) -> Result<Node> {
        let client = self.client.lock().await;
        let row = client
            .query_opt(
                "SELECT node_id, kind, mode, uid, gid, size, nlink, atime_ns,
                        mtime_ns, ctime_ns, symlink_target, deleted
                   FROM _openeral.fs_nodes
                  WHERE volume_id = $1 AND node_id = $2",
                &[&self.volume_id, &node_id],
            )
            .await?
            .ok_or(Error::NotFound)?;
        node_from_row(&row)
    }

    pub async fn list_directory(&self, parent_node_id: i64) -> Result<Vec<DirectoryEntry>> {
        let client = self.client.lock().await;
        let rows = client
            .query(
                "SELECT d.name, n.node_id, n.kind, n.mode, n.uid, n.gid, n.size,
                        n.nlink, n.atime_ns, n.mtime_ns, n.ctime_ns,
                        n.symlink_target, n.deleted
                   FROM _openeral.fs_dirents d
                   JOIN _openeral.fs_nodes n
                     ON n.volume_id = d.volume_id AND n.node_id = d.child_node_id
                  WHERE d.volume_id = $1 AND d.parent_node_id = $2
                  ORDER BY d.name",
                &[&self.volume_id, &parent_node_id],
            )
            .await?;
        rows.into_iter()
            .map(|row| {
                let name = row.get::<_, Vec<u8>>(0);
                let node = node_from_row_offset(&row, 1)?;
                Ok(DirectoryEntry { name, node })
            })
            .collect()
    }

    pub async fn parent_of(&self, node_id: i64) -> Result<i64> {
        if node_id == self.root_node_id {
            return Ok(self.root_node_id);
        }
        let client = self.client.lock().await;
        client
            .query_opt(
                "SELECT parent_node_id FROM _openeral.fs_dirents
                  WHERE volume_id = $1 AND child_node_id = $2",
                &[&self.volume_id, &node_id],
            )
            .await?
            .map(|row| row.get(0))
            .ok_or(Error::NotFound)
    }

    pub async fn read_chunk(&self, node_id: i64, chunk_index: i64) -> Result<Vec<u8>> {
        let client = self.client.lock().await;
        Ok(client
            .query_opt(
                "SELECT data FROM _openeral.fs_chunks
                  WHERE volume_id = $1 AND node_id = $2 AND chunk_index = $3",
                &[&self.volume_id, &node_id, &chunk_index],
            )
            .await?
            .map_or_else(Vec::new, |row| row.get(0)))
    }

    pub async fn create_node(
        &self,
        parent_node_id: i64,
        name: &[u8],
        kind: NodeKind,
        mode: u32,
        uid: u32,
        gid: u32,
        symlink_target: Option<&[u8]>,
    ) -> Result<Node> {
        crate::model::validate_name(name).map_err(|message| Error::Invalid(message.into()))?;
        let parent_bytes = parent_node_id.to_be_bytes();
        let kind_bytes = (kind as i16).to_be_bytes();
        let operation = PendingOperation::new(&[b"create", &parent_bytes, name, &kind_bytes]);
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        let parent_kind: i16 = tx
            .query_opt(
                "SELECT kind FROM _openeral.fs_nodes
                  WHERE volume_id = $1 AND node_id = $2 AND NOT deleted FOR UPDATE",
                &[&self.volume_id, &parent_node_id],
            )
            .await?
            .ok_or(Error::NotFound)?
            .get(0);
        if NodeKind::try_from(parent_kind).map_err(Error::Internal)? != NodeKind::Directory {
            return Err(Error::NotDirectory);
        }
        let timestamp = now_ns();
        let target = symlink_target.map(<[u8]>::to_vec);
        let size = target.as_ref().map_or(0_i64, |value| value.len() as i64);
        let nlink = if kind == NodeKind::Directory {
            2_i32
        } else {
            1_i32
        };
        let row = tx
            .query_one(
                "INSERT INTO _openeral.fs_nodes
                   (volume_id, kind, mode, uid, gid, size, nlink, atime_ns, mtime_ns,
                    ctime_ns, symlink_target)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9)
                 RETURNING node_id, kind, mode, uid, gid, size, nlink, atime_ns,
                           mtime_ns, ctime_ns, symlink_target, deleted",
                &[
                    &self.volume_id,
                    &(kind as i16),
                    &(mode as i32 & 0o7777),
                    &(uid as i32),
                    &(gid as i32),
                    &size,
                    &nlink,
                    &timestamp,
                    &target,
                ],
            )
            .await?;
        let node = node_from_row(&row)?;
        tx.execute(
            "INSERT INTO _openeral.fs_dirents
               (volume_id, parent_node_id, name, child_node_id)
             VALUES ($1, $2, $3, $4)",
            &[&self.volume_id, &parent_node_id, &name, &node.node_id],
        )
        .await
        .map_err(map_constraint_error)?;
        let parent_nlink_delta = i32::from(kind == NodeKind::Directory);
        tx.execute(
            "UPDATE _openeral.fs_nodes
                SET nlink = nlink + $3, mtime_ns = $4, ctime_ns = $4,
                    generation = generation + 1
              WHERE volume_id = $1 AND node_id = $2",
            &[
                &self.volume_id,
                &parent_node_id,
                &parent_nlink_delta,
                &timestamp,
            ],
        )
        .await?;
        record_operation(&tx, self, &operation, json!({ "nodeId": node.node_id })).await?;
        self.commit_operation(tx, &operation).await?;
        Ok(node)
    }

    pub async fn truncate(&self, node_id: i64, size: i64) -> Result<Node> {
        if size < 0 {
            return Err(Error::Invalid("negative truncate size".into()));
        }
        let node_bytes = node_id.to_be_bytes();
        let size_bytes = size.to_be_bytes();
        let operation = PendingOperation::new(&[b"truncate", &node_bytes, &size_bytes]);
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        let timestamp = now_ns();
        let row = tx
            .query_opt(
                "UPDATE _openeral.fs_nodes
                    SET size = $3, mtime_ns = $4, ctime_ns = $4, generation = generation + 1
                  WHERE volume_id = $1 AND node_id = $2 AND kind = 1 AND NOT deleted
                  RETURNING node_id, kind, mode, uid, gid, size, nlink, atime_ns,
                            mtime_ns, ctime_ns, symlink_target, deleted",
                &[&self.volume_id, &node_id, &size, &timestamp],
            )
            .await?
            .ok_or(Error::NotFound)?;
        let first_removed =
            (size + crate::model::CHUNK_SIZE as i64 - 1) / crate::model::CHUNK_SIZE as i64;
        tx.execute(
            "DELETE FROM _openeral.fs_chunks
              WHERE volume_id = $1 AND node_id = $2 AND chunk_index >= $3",
            &[&self.volume_id, &node_id, &first_removed],
        )
        .await?;
        if size > 0 && size % crate::model::CHUNK_SIZE as i64 != 0 {
            let retained_index = size / crate::model::CHUNK_SIZE as i64;
            let retained_len = (size % crate::model::CHUNK_SIZE as i64) as i32;
            tx.execute(
                "UPDATE _openeral.fs_chunks SET data = SUBSTRING(data FROM 1 FOR $4)
                  WHERE volume_id = $1 AND node_id = $2 AND chunk_index = $3",
                &[&self.volume_id, &node_id, &retained_index, &retained_len],
            )
            .await?;
        }
        record_operation(&tx, self, &operation, json!({ "size": size })).await?;
        self.commit_operation(tx, &operation).await?;
        node_from_row(&row)
    }

    pub async fn update_attributes(
        &self,
        node_id: i64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        atime_ns: Option<i64>,
        mtime_ns: Option<i64>,
    ) -> Result<Node> {
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        let timestamp = now_ns();
        let node_bytes = node_id.to_be_bytes();
        let timestamp_bytes = timestamp.to_be_bytes();
        let operation = PendingOperation::new(&[b"setattr", &node_bytes, &timestamp_bytes]);
        let row = tx
            .query_opt(
                "UPDATE _openeral.fs_nodes
                    SET mode = COALESCE($3, mode), uid = COALESCE($4, uid),
                        gid = COALESCE($5, gid), atime_ns = COALESCE($6, atime_ns),
                        mtime_ns = COALESCE($7, mtime_ns), ctime_ns = $8,
                        generation = generation + 1
                  WHERE volume_id = $1 AND node_id = $2 AND NOT deleted
                  RETURNING node_id, kind, mode, uid, gid, size, nlink, atime_ns,
                            mtime_ns, ctime_ns, symlink_target, deleted",
                &[
                    &self.volume_id,
                    &node_id,
                    &mode.map(|value| value as i32 & 0o7777),
                    &uid.map(|value| value as i32),
                    &gid.map(|value| value as i32),
                    &atime_ns,
                    &mtime_ns,
                    &timestamp,
                ],
            )
            .await?
            .ok_or(Error::NotFound)?;
        record_operation(&tx, self, &operation, json!({ "nodeId": node_id })).await?;
        self.commit_operation(tx, &operation).await?;
        node_from_row(&row)
    }

    pub async fn flush_snapshot(&self, snapshot: &DataSnapshot) -> Result<()> {
        let node_bytes = snapshot.node_id.to_be_bytes();
        let sequence_bytes = snapshot.through_sequence.to_be_bytes();
        let operation = PendingOperation::new(&[b"flush", &node_bytes, &sequence_bytes]);
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        // These requests are independent inside the same transaction. Polling
        // them together lets tokio-postgres pipeline them across a high-latency
        // connection; PostgreSQL still executes them in request order. If the
        // lease is stale or any mutation fails, the uncommitted transaction is
        // dropped and every pipelined change is rolled back.
        let (lease, persisted, recorded) = tokio::join!(
            biased;
            verify_lease(&tx, self),
            persist_snapshot(&tx, self, snapshot),
            record_operation(
                &tx,
                self,
                &operation,
                json!({ "sequence": snapshot.through_sequence }),
            ),
        );
        lease?;
        persisted?;
        recorded?;
        self.commit_operation(tx, &operation).await?;
        Ok(())
    }

    pub async fn rename(
        &self,
        parent_node_id: i64,
        name: &[u8],
        new_parent_node_id: i64,
        new_name: &[u8],
        no_replace: bool,
        snapshot: Option<&DataSnapshot>,
    ) -> Result<()> {
        crate::model::validate_name(name).map_err(|message| Error::Invalid(message.into()))?;
        crate::model::validate_name(new_name).map_err(|message| Error::Invalid(message.into()))?;
        if parent_node_id == new_parent_node_id && name == new_name {
            return Ok(());
        }
        let parent_bytes = parent_node_id.to_be_bytes();
        let new_parent_bytes = new_parent_node_id.to_be_bytes();
        let snapshot_sequence = snapshot.map_or(0, |value| value.through_sequence);
        let snapshot_bytes = snapshot_sequence.to_be_bytes();
        let operation = PendingOperation::new(&[
            b"rename",
            &parent_bytes,
            name,
            &new_parent_bytes,
            new_name,
            &snapshot_bytes,
        ]);
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        // Lease, source, destination parent, and destination are independent
        // reads. Pipeline them so an atomic save pays one database network wait
        // instead of four while retaining the same SERIALIZABLE row locks.
        let (lease, source, new_parent, destination) = tokio::join!(
            biased;
            verify_lease(&tx, self),
            async {
                tx.query_opt(
                    "SELECT n.node_id, n.kind
                       FROM _openeral.fs_dirents d
                       JOIN _openeral.fs_nodes n
                         ON n.volume_id = d.volume_id AND n.node_id = d.child_node_id
                      WHERE d.volume_id = $1 AND d.parent_node_id = $2 AND d.name = $3
                      FOR UPDATE OF d, n",
                    &[&self.volume_id, &parent_node_id, &name],
                )
                .await
            },
            async {
                tx.query_opt(
                    "SELECT kind FROM _openeral.fs_nodes
                      WHERE volume_id = $1 AND node_id = $2 AND NOT deleted FOR UPDATE",
                    &[&self.volume_id, &new_parent_node_id],
                )
                .await
            },
            async {
                tx.query_opt(
                    "SELECT n.node_id, n.kind
                       FROM _openeral.fs_dirents d
                       JOIN _openeral.fs_nodes n
                         ON n.volume_id = d.volume_id AND n.node_id = d.child_node_id
                      WHERE d.volume_id = $1 AND d.parent_node_id = $2 AND d.name = $3
                      FOR UPDATE OF d, n",
                    &[&self.volume_id, &new_parent_node_id, &new_name],
                )
                .await
            },
        );
        lease?;
        let source = source?.ok_or(Error::NotFound)?;
        let source_id: i64 = source.get(0);
        let source_kind = NodeKind::try_from(source.get::<_, i16>(1)).map_err(Error::Internal)?;
        if snapshot.is_some_and(|value| value.node_id != source_id) {
            return Err(Error::Internal("rename snapshot inode mismatch".into()));
        }
        let new_parent_kind: i16 = new_parent?.ok_or(Error::NotFound)?.get(0);
        if NodeKind::try_from(new_parent_kind).map_err(Error::Internal)? != NodeKind::Directory {
            return Err(Error::NotDirectory);
        }
        if source_kind == NodeKind::Directory {
            let creates_cycle: bool = tx
                .query_one(
                    "WITH RECURSIVE descendants(node_id) AS (
                       SELECT $2::bigint
                       UNION ALL
                       SELECT d.child_node_id
                         FROM _openeral.fs_dirents d
                         JOIN descendants x ON x.node_id = d.parent_node_id
                        WHERE d.volume_id = $1
                     ) SELECT EXISTS(SELECT 1 FROM descendants WHERE node_id = $3)",
                    &[&self.volume_id, &source_id, &new_parent_node_id],
                )
                .await?
                .get(0);
            if creates_cycle {
                return Err(Error::Invalid(
                    "directory rename would create a cycle".into(),
                ));
            }
        }
        let destination = destination?;
        let mut destination_was_directory = false;
        let mut destination_id = None;
        if no_replace && destination.is_some() {
            return Err(Error::Exists);
        }
        if let Some(destination) = destination {
            let replaced_id: i64 = destination.get(0);
            let destination_kind =
                NodeKind::try_from(destination.get::<_, i16>(1)).map_err(Error::Internal)?;
            if source_kind == NodeKind::Directory && destination_kind != NodeKind::Directory {
                return Err(Error::NotDirectory);
            }
            if source_kind != NodeKind::Directory && destination_kind == NodeKind::Directory {
                return Err(Error::IsDirectory);
            }
            if destination_kind == NodeKind::Directory {
                destination_was_directory = true;
                let has_children: bool = tx
                    .query_one(
                        "SELECT EXISTS(SELECT 1 FROM _openeral.fs_dirents
                          WHERE volume_id = $1 AND parent_node_id = $2)",
                        &[&self.volume_id, &replaced_id],
                    )
                    .await?
                    .get(0);
                if has_children {
                    return Err(Error::NotEmpty);
                }
            }
            destination_id = Some(replaced_id);
        }
        let timestamp = now_ns();
        let source_moves_directory =
            source_kind == NodeKind::Directory && parent_node_id != new_parent_node_id;

        // Poll the mutation requests in dependency order so tokio-postgres can
        // send them as one pipeline. PostgreSQL executes them sequentially in
        // that order and the transaction is committed only after every result
        // has been checked.
        let (replaced, persisted, moved, parents_updated, source_updated, recorded) = tokio::join!(
            biased;
            async {
                if let Some(destination_id) = destination_id {
                    tx.execute(
                        "WITH removed AS (
                           DELETE FROM _openeral.fs_dirents
                            WHERE volume_id = $1 AND parent_node_id = $2 AND name = $3
                            RETURNING 1
                         )
                         UPDATE _openeral.fs_nodes
                            SET deleted = TRUE, nlink = 0, ctime_ns = $5
                          WHERE volume_id = $1 AND node_id = $4
                            AND EXISTS (SELECT 1 FROM removed)",
                        &[
                            &self.volume_id,
                            &new_parent_node_id,
                            &new_name,
                            &destination_id,
                            &timestamp,
                        ],
                    )
                    .await?;
                }
                Ok::<(), tokio_postgres::Error>(())
            },
            async {
                if let Some(snapshot) = snapshot {
                    persist_snapshot(&tx, self, snapshot).await?;
                }
                Ok::<(), Error>(())
            },
            async {
                tx.execute(
                    "WITH removed AS (
                       DELETE FROM _openeral.fs_dirents
                        WHERE volume_id = $1 AND parent_node_id = $2 AND name = $3
                        RETURNING child_node_id
                     )
                     INSERT INTO _openeral.fs_dirents
                        (volume_id, parent_node_id, name, child_node_id)
                     SELECT $1, $4, $5, child_node_id FROM removed",
                    &[
                        &self.volume_id,
                        &parent_node_id,
                        &name,
                        &new_parent_node_id,
                        &new_name,
                    ],
                )
                .await
            },
            async {
                if parent_node_id == new_parent_node_id {
                    let delta = -i32::from(destination_was_directory);
                    tx.execute(
                        "UPDATE _openeral.fs_nodes
                            SET nlink = nlink + $3, mtime_ns = $4, ctime_ns = $4,
                                generation = generation + 1
                          WHERE volume_id = $1 AND node_id = $2",
                        &[&self.volume_id, &parent_node_id, &delta, &timestamp],
                    )
                    .await?;
                } else {
                    let old_delta = -i32::from(source_moves_directory);
                    let new_delta = i32::from(source_moves_directory)
                        - i32::from(destination_was_directory);
                    tx.execute(
                        "UPDATE _openeral.fs_nodes
                            SET nlink = nlink + $3, mtime_ns = $4, ctime_ns = $4,
                                generation = generation + 1
                          WHERE volume_id = $1 AND node_id = $2",
                        &[&self.volume_id, &parent_node_id, &old_delta, &timestamp],
                    )
                    .await?;
                    tx.execute(
                        "UPDATE _openeral.fs_nodes
                            SET nlink = nlink + $3, mtime_ns = $4, ctime_ns = $4,
                                generation = generation + 1
                          WHERE volume_id = $1 AND node_id = $2",
                        &[&self.volume_id, &new_parent_node_id, &new_delta, &timestamp],
                    )
                    .await?;
                }
                Ok::<(), tokio_postgres::Error>(())
            },
            async {
                tx.execute(
                    "UPDATE _openeral.fs_nodes
                        SET ctime_ns = $3, generation = generation + 1
                      WHERE volume_id = $1 AND node_id = $2",
                    &[&self.volume_id, &source_id, &timestamp],
                )
                .await
            },
            record_operation(&tx, self, &operation, json!({ "nodeId": source_id })),
        );
        replaced?;
        persisted?;
        if moved? != 1 {
            return Err(Error::NotFound);
        }
        parents_updated?;
        if source_updated? != 1 {
            return Err(Error::NotFound);
        }
        recorded?;
        self.commit_operation(tx, &operation).await?;
        Ok(())
    }

    pub async fn remove(&self, parent_node_id: i64, name: &[u8], directory: bool) -> Result<i64> {
        crate::model::validate_name(name).map_err(|message| Error::Invalid(message.into()))?;
        let parent_bytes = parent_node_id.to_be_bytes();
        let directory_byte = [u8::from(directory)];
        let operation = PendingOperation::new(&[b"remove", &parent_bytes, name, &directory_byte]);
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        let row = tx
            .query_opt(
                "SELECT n.node_id, n.kind
                   FROM _openeral.fs_dirents d
                   JOIN _openeral.fs_nodes n
                     ON n.volume_id = d.volume_id AND n.node_id = d.child_node_id
                  WHERE d.volume_id = $1 AND d.parent_node_id = $2 AND d.name = $3
                  FOR UPDATE OF d, n",
                &[&self.volume_id, &parent_node_id, &name],
            )
            .await?
            .ok_or(Error::NotFound)?;
        let node_id: i64 = row.get(0);
        let kind = NodeKind::try_from(row.get::<_, i16>(1)).map_err(Error::Internal)?;
        if directory && kind != NodeKind::Directory {
            return Err(Error::NotDirectory);
        }
        if !directory && kind == NodeKind::Directory {
            return Err(Error::IsDirectory);
        }
        if directory {
            let has_children: bool = tx
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM _openeral.fs_dirents
                      WHERE volume_id = $1 AND parent_node_id = $2)",
                    &[&self.volume_id, &node_id],
                )
                .await?
                .get(0);
            if has_children {
                return Err(Error::NotEmpty);
            }
        }
        tx.execute(
            "DELETE FROM _openeral.fs_dirents
              WHERE volume_id = $1 AND parent_node_id = $2 AND name = $3",
            &[&self.volume_id, &parent_node_id, &name],
        )
        .await?;
        tx.execute(
            "UPDATE _openeral.fs_nodes SET deleted = TRUE, nlink = 0, ctime_ns = $3
              WHERE volume_id = $1 AND node_id = $2",
            &[&self.volume_id, &node_id, &now_ns()],
        )
        .await?;
        let timestamp = now_ns();
        let parent_nlink_delta = -i32::from(directory);
        tx.execute(
            "UPDATE _openeral.fs_nodes
                SET nlink = nlink + $3, mtime_ns = $4, ctime_ns = $4,
                    generation = generation + 1
              WHERE volume_id = $1 AND node_id = $2",
            &[
                &self.volume_id,
                &parent_node_id,
                &parent_nlink_delta,
                &timestamp,
            ],
        )
        .await?;
        record_operation(&tx, self, &operation, json!({ "nodeId": node_id })).await?;
        self.commit_operation(tx, &operation).await?;
        Ok(node_id)
    }

    pub async fn collect_deleted_node(&self, node_id: i64) -> Result<()> {
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        tx.execute(
            "DELETE FROM _openeral.fs_nodes
              WHERE volume_id = $1 AND node_id = $2 AND deleted
                AND NOT EXISTS (
                  SELECT 1 FROM _openeral.fs_dirents
                   WHERE volume_id = $1 AND child_node_id = $2
                )",
            &[&self.volume_id, &node_id],
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn startup_gc(&self) -> Result<u64> {
        let mut client = self.client.lock().await;
        let tx = serializable(&mut client).await?;
        verify_lease(&tx, self).await?;
        let removed = tx
            .execute(
                "DELETE FROM _openeral.fs_nodes n
                  WHERE n.volume_id = $1 AND n.deleted
                    AND NOT EXISTS (
                      SELECT 1 FROM _openeral.fs_dirents d
                       WHERE d.volume_id = n.volume_id AND d.child_node_id = n.node_id
                    )",
                &[&self.volume_id],
            )
            .await?;
        tx.execute(
            "DELETE FROM _openeral.fs_operations
              WHERE committed_at < NOW() - INTERVAL '7 days'",
            &[],
        )
        .await?;
        tx.commit().await?;
        Ok(removed)
    }

    pub async fn statfs(&self) -> Result<(u64, u64)> {
        let client = self.client.lock().await;
        let row = client
            .query_one(
                "SELECT COALESCE(SUM(size), 0)::bigint, COUNT(*)::bigint
                   FROM _openeral.fs_nodes WHERE volume_id = $1 AND NOT deleted",
                &[&self.volume_id],
            )
            .await?;
        Ok((row.get::<_, i64>(0) as u64, row.get::<_, i64>(1) as u64))
    }
}

async fn ensure_volume(
    client: &mut Client,
    volume_id: &str,
    workspace_id: &str,
    uid: u32,
    gid: u32,
) -> Result<i64> {
    if let Some(row) = client
        .query_opt(
            "SELECT root_node_id, schema_version FROM _openeral.fs_volumes
              WHERE workspace_id = $1",
            &[&workspace_id],
        )
        .await
        .map_err(|error| Error::database("reading the prepared filesystem volume", error))?
    {
        let schema: i32 = row.get(1);
        if schema != SCHEMA_VERSION {
            return Err(Error::Internal(format!(
                "filesystem schema version {schema} is not supported"
            )));
        }
        return Ok(row.get(0));
    }

    let tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::Serializable)
        .start()
        .await?;
    tx.batch_execute("SET CONSTRAINTS ALL DEFERRED").await?;
    tx.execute(
        "INSERT INTO _openeral.fs_volumes
           (volume_id, workspace_id, root_node_id, schema_version)
         VALUES ($1, $2, 0, $3)",
        &[&volume_id, &workspace_id, &SCHEMA_VERSION],
    )
    .await
    .map_err(map_constraint_error)?;
    let timestamp = now_ns();
    let root_node_id: i64 = tx
        .query_one(
            "INSERT INTO _openeral.fs_nodes
               (volume_id, kind, mode, uid, gid, size, nlink, atime_ns, mtime_ns, ctime_ns)
             VALUES ($1, 2, 493, $2, $3, 0, 2, $4, $4, $4)
             RETURNING node_id",
            &[&volume_id, &(uid as i32), &(gid as i32), &timestamp],
        )
        .await?
        .get(0);
    tx.execute(
        "UPDATE _openeral.fs_volumes SET root_node_id = $2 WHERE volume_id = $1",
        &[&volume_id, &root_node_id],
    )
    .await?;
    tx.commit().await?;
    Ok(root_node_id)
}

async fn serializable(client: &mut Client) -> Result<Transaction<'_>> {
    Ok(client
        .build_transaction()
        .isolation_level(IsolationLevel::Serializable)
        .start()
        .await?)
}

async fn verify_lease(tx: &Transaction<'_>, store: &PgStore) -> Result<()> {
    let valid = tx
        .query_opt(
            "SELECT 1 FROM _openeral.fs_mount_epochs
              WHERE volume_id = $1 AND owner_id = $2 AND epoch = $3
                AND lease_expires_at > NOW()
              FOR UPDATE",
            &[&store.volume_id, &store.owner_id, &store.epoch],
        )
        .await?
        .is_some();
    if !valid {
        return Err(Error::Fenced);
    }
    Ok(())
}

async fn persist_snapshot(
    tx: &Transaction<'_>,
    store: &PgStore,
    snapshot: &DataSnapshot,
) -> Result<()> {
    let indices = snapshot
        .chunks
        .iter()
        .map(|ChunkWrite { index, .. }| *index)
        .collect::<Vec<_>>();
    let data = snapshot
        .chunks
        .iter()
        .map(|ChunkWrite { data, .. }| data.clone())
        .collect::<Vec<_>>();
    let updated = tx
        .execute(
            "WITH persisted_chunks AS (
               INSERT INTO _openeral.fs_chunks (volume_id, node_id, chunk_index, data)
               SELECT $1, $2, chunks.chunk_index, chunks.data
                 FROM UNNEST($3::bigint[], $4::bytea[])
                        AS chunks(chunk_index, data)
               ON CONFLICT (volume_id, node_id, chunk_index)
               DO UPDATE SET data = EXCLUDED.data
               RETURNING 1
             )
             UPDATE _openeral.fs_nodes
                SET size = $5, mtime_ns = $6, ctime_ns = $6, generation = generation + 1
              WHERE volume_id = $1 AND node_id = $2 AND kind = 1",
            &[
                &store.volume_id,
                &snapshot.node_id,
                &indices,
                &data,
                &snapshot.size,
                &snapshot.mtime_ns,
            ],
        )
        .await?;
    if updated != 1 {
        return Err(Error::NotFound);
    }
    Ok(())
}

async fn record_operation(
    tx: &Transaction<'_>,
    store: &PgStore,
    operation: &PendingOperation,
    result: serde_json::Value,
) -> Result<()> {
    tx.execute(
        "INSERT INTO _openeral.fs_operations
           (volume_id, epoch, operation_id, request_hash, result)
         VALUES ($1, $2, $3, $4, $5)",
        &[
            &store.volume_id,
            &store.epoch,
            &operation.id,
            &&operation.request_hash[..],
            &result,
        ],
    )
    .await?;
    Ok(())
}

fn operation_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}

fn node_from_row(row: &Row) -> Result<Node> {
    node_from_row_offset(row, 0)
}

fn node_from_row_offset(row: &Row, offset: usize) -> Result<Node> {
    Ok(Node {
        node_id: row.get(offset),
        kind: NodeKind::try_from(row.get::<_, i16>(offset + 1)).map_err(Error::Internal)?,
        mode: row.get(offset + 2),
        uid: row.get(offset + 3),
        gid: row.get(offset + 4),
        size: row.get(offset + 5),
        nlink: row.get(offset + 6),
        atime_ns: row.get(offset + 7),
        mtime_ns: row.get(offset + 8),
        ctime_ns: row.get(offset + 9),
        symlink_target: row.get(offset + 10),
        deleted: row.get(offset + 11),
    })
}

fn map_constraint_error(error: tokio_postgres::Error) -> Error {
    match error.code().map(tokio_postgres::error::SqlState::code) {
        Some("23505") => Error::Exists,
        Some("23503") => Error::NotFound,
        _ => Error::database("applying a filesystem constraint", error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_hash_is_framed_and_deterministic() {
        assert_eq!(
            operation_hash(&[b"ab", b"c"]),
            operation_hash(&[b"ab", b"c"])
        );
        assert_ne!(
            operation_hash(&[b"ab", b"c"]),
            operation_hash(&[b"a", b"bc"])
        );
    }

    #[test]
    fn pending_operations_have_unique_ids_and_stable_request_hashes() {
        let first = PendingOperation::new(&[b"write", b"same"]);
        let second = PendingOperation::new(&[b"write", b"same"]);
        assert_ne!(first.id, second.id);
        assert_eq!(first.request_hash, second.request_hash);
    }
}
