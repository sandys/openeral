use crate::error::{Error, Result};
use crate::model::{now_ns, ChunkWrite, DataSnapshot, DirectoryEntry, Node, CHUNK_SIZE};
use crate::store::PgStore;
use dashmap::DashMap;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const MAX_DIRTY_PER_INODE: usize = 16 * 1024 * 1024;
pub const MAX_DIRTY_GLOBAL: usize = 64 * 1024 * 1024;

/// Result of an authoritative cached directory lookup.
#[derive(Debug, Clone)]
pub enum CachedLookup {
    Found(Node),
    Missing,
}

/// Read-mostly metadata cache for the single-writer mounted volume.
///
/// Claude Code performs many synchronous `stat`/directory probes while it
/// paints and updates its prompt. Sending each one to a remote PostgreSQL
/// session serializes the TUI behind network round trips. The writer lease
/// guarantees that namespace mutations for this mount pass through this daemon,
/// so an authoritative per-mount cache is safe as long as every mutation bumps
/// the generation. Values carry the generation they were loaded under: a slow
/// query that races an invalidation can still satisfy its in-flight FUSE request,
/// but it cannot repopulate stale data for later requests.
#[derive(Default)]
pub struct MetadataCache {
    generation: AtomicU64,
    nodes: DashMap<i64, (u64, Node)>,
    directories: DashMap<i64, (u64, Arc<Vec<DirectoryEntry>>)>,
    parents: DashMap<i64, (u64, i64)>,
    lookups: DashMap<(i64, Vec<u8>), (u64, i64)>,
}

impl MetadataCache {
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn node(&self, node_id: i64) -> Option<Node> {
        let generation = self.generation();
        self.nodes.get(&node_id).and_then(|entry| {
            let (cached_generation, node) = entry.value();
            (*cached_generation == generation).then(|| node.clone())
        })
    }

    /// Returns `Some(Missing)` only when the parent directory has been loaded in
    /// full. That makes negative lookups authoritative without one SQL query per
    /// absent `.claude`/`.git`/config probe.
    #[must_use]
    pub fn lookup(&self, parent_id: i64, name: &[u8]) -> Option<CachedLookup> {
        let generation = self.generation();
        if let Some(entry) = self.lookups.get(&(parent_id, name.to_vec())) {
            let (cached_generation, node_id) = *entry.value();
            if cached_generation == generation {
                return self.node(node_id).map(CachedLookup::Found);
            }
        }
        self.directories
            .get(&parent_id)
            .filter(|entry| entry.value().0 == generation)
            .map(|_| CachedLookup::Missing)
    }

    #[must_use]
    pub fn directory(&self, node_id: i64) -> Option<Arc<Vec<DirectoryEntry>>> {
        let generation = self.generation();
        self.directories.get(&node_id).and_then(|entry| {
            let (cached_generation, entries) = entry.value();
            (*cached_generation == generation).then(|| Arc::clone(entries))
        })
    }

    #[must_use]
    pub fn parent(&self, node_id: i64) -> Option<i64> {
        let generation = self.generation();
        self.parents.get(&node_id).and_then(|entry| {
            let (cached_generation, parent_id) = *entry.value();
            (cached_generation == generation).then_some(parent_id)
        })
    }

    pub fn remember_node(&self, generation: u64, node: Node) {
        if self.generation() == generation {
            self.nodes.insert(node.node_id, (generation, node));
        }
    }

    pub fn remember_parent(&self, generation: u64, node_id: i64, parent_id: i64) {
        if self.generation() == generation {
            self.parents.insert(node_id, (generation, parent_id));
        }
    }

    pub fn remember_directory(
        &self,
        generation: u64,
        parent_id: i64,
        entries: Arc<Vec<DirectoryEntry>>,
    ) {
        if self.generation() != generation {
            return;
        }
        for entry in entries.iter() {
            self.nodes
                .insert(entry.node.node_id, (generation, entry.node.clone()));
            self.lookups.insert(
                (parent_id, entry.name.clone()),
                (generation, entry.node.node_id),
            );
        }
        self.directories
            .insert(parent_id, (generation, entries));
    }

    /// Keep cached attributes coherent after an in-place mutation. Namespace
    /// mutations use `invalidate` instead because they affect multiple lookup
    /// and directory keys.
    pub fn replace_node(&self, node: Node) {
        let generation = self.generation();
        self.nodes.insert(node.node_id, (generation, node));
    }

    pub fn patch_file_state(&self, node_id: i64, size: i64, mtime_ns: i64) {
        let generation = self.generation();
        if let Some(mut entry) = self.nodes.get_mut(&node_id) {
            if entry.value().0 == generation {
                entry.value_mut().1.size = size;
                entry.value_mut().1.mtime_ns = mtime_ns;
                entry.value_mut().1.ctime_ns = mtime_ns;
            }
        }
    }

    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.nodes.clear();
        self.directories.clear();
        self.parents.clear();
        self.lookups.clear();
    }
}

#[derive(Clone)]
struct DirtyChunk {
    data: Vec<u8>,
    sequence: u64,
}

struct InodeData {
    size: i64,
    mtime_ns: i64,
    next_sequence: u64,
    dirty: BTreeMap<i64, DirtyChunk>,
    writeback_error: Option<String>,
}

pub struct InodeState {
    node_id: i64,
    inner: Mutex<InodeData>,
    writeback: tokio::sync::Mutex<()>,
}

impl InodeState {
    fn new(node: &Node) -> Self {
        Self {
            node_id: node.node_id,
            inner: Mutex::new(InodeData {
                size: node.size,
                mtime_ns: node.mtime_ns,
                next_sequence: 1,
                dirty: BTreeMap::new(),
                writeback_error: None,
            }),
            writeback: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn lock_writeback(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.writeback.lock().await
    }

    pub async fn prepare_chunks(&self, store: &PgStore, offset: u64, len: usize) -> Result<()> {
        if len == 0 {
            return Ok(());
        }
        let first = (offset as usize / CHUNK_SIZE) as i64;
        let last = ((offset as usize + len - 1) / CHUNK_SIZE) as i64;
        let (missing, file_size) = {
            let inner = self.inner.lock();
            (
                (first..=last)
                    .filter(|index| !inner.dirty.contains_key(index))
                    .collect::<Vec<_>>(),
                inner.size.max(0),
            )
        };
        for index in missing {
            // A chunk wholly beyond the current EOF cannot have persisted data.
            // Avoiding that guaranteed-empty PostgreSQL read is important for
            // atomic-save temp files and append-heavy CLI caches on a remote DB.
            // Partial overwrites of the existing final chunk still read it.
            let chunk_start = index * CHUNK_SIZE as i64;
            let mut data = if chunk_start >= file_size {
                Vec::new()
            } else {
                store.read_chunk(self.node_id, index).await?
            };
            data.resize(CHUNK_SIZE, 0);
            let mut inner = self.inner.lock();
            inner
                .dirty
                .entry(index)
                .or_insert(DirtyChunk { data, sequence: 0 });
        }
        Ok(())
    }

    pub fn write(&self, offset: u64, bytes: &[u8]) -> Result<u64> {
        let mut inner = self.inner.lock();
        if let Some(error) = &inner.writeback_error {
            return Err(Error::Internal(format!("prior writeback failed: {error}")));
        }
        let sequence = inner.next_sequence;
        inner.next_sequence += 1;
        let mut consumed = 0;
        while consumed < bytes.len() {
            let absolute = offset as usize + consumed;
            let index = (absolute / CHUNK_SIZE) as i64;
            let within = absolute % CHUNK_SIZE;
            let count = (CHUNK_SIZE - within).min(bytes.len() - consumed);
            let chunk = inner
                .dirty
                .get_mut(&index)
                .ok_or_else(|| Error::Internal("write chunk was not prepared".into()))?;
            chunk.data[within..within + count].copy_from_slice(&bytes[consumed..consumed + count]);
            chunk.sequence = sequence;
            consumed += count;
        }
        inner.size = inner.size.max((offset as usize + bytes.len()) as i64);
        inner.mtime_ns = now_ns();
        Ok(sequence)
    }

    pub async fn read(&self, store: &PgStore, offset: u64, size: u32) -> Result<Vec<u8>> {
        let file_size = self.inner.lock().size.max(0) as u64;
        if offset >= file_size || size == 0 {
            return Ok(Vec::new());
        }
        let end = (offset + u64::from(size)).min(file_size);
        let mut output = Vec::with_capacity((end - offset) as usize);
        let first = (offset as usize / CHUNK_SIZE) as i64;
        let last = ((end as usize - 1) / CHUNK_SIZE) as i64;
        for index in first..=last {
            let cached = self
                .inner
                .lock()
                .dirty
                .get(&index)
                .map(|chunk| chunk.data.clone());
            let mut data = match cached {
                Some(data) => data,
                None => store.read_chunk(self.node_id, index).await?,
            };
            data.resize(CHUNK_SIZE, 0);
            let chunk_start = index as u64 * CHUNK_SIZE as u64;
            let from = offset.saturating_sub(chunk_start) as usize;
            let to = (end.saturating_sub(chunk_start) as usize).min(CHUNK_SIZE);
            if to > from {
                output.extend_from_slice(&data[from..to]);
            }
        }
        Ok(output)
    }

    #[must_use]
    pub fn snapshot(&self) -> Option<DataSnapshot> {
        let inner = self.inner.lock();
        let through_sequence = inner
            .dirty
            .values()
            .filter(|chunk| chunk.sequence > 0)
            .map(|chunk| chunk.sequence)
            .max()?;
        let chunks = inner
            .dirty
            .iter()
            .filter(|(_, chunk)| chunk.sequence > 0)
            .filter_map(|(index, chunk)| {
                let start = *index * CHUNK_SIZE as i64;
                if start >= inner.size {
                    return None;
                }
                let stored_len = (inner.size - start).min(CHUNK_SIZE as i64) as usize;
                Some(ChunkWrite {
                    index: *index,
                    data: chunk.data[..stored_len].to_vec(),
                })
            })
            .collect::<Vec<_>>();
        if chunks.is_empty() {
            return None;
        }
        Some(DataSnapshot {
            node_id: self.node_id,
            through_sequence,
            size: inner.size,
            mtime_ns: inner.mtime_ns,
            chunks,
        })
    }

    pub fn committed(&self, snapshot: &DataSnapshot) {
        let mut inner = self.inner.lock();
        inner
            .dirty
            .retain(|_, chunk| chunk.sequence > snapshot.through_sequence);
        // The data that previously failed to write back has now been committed,
        // so nothing was lost: clear the sticky error instead of refusing every
        // later write to this inode forever. Discarded (fenced) data never
        // reaches this path because it is removed from `dirty` first.
        inner.writeback_error = None;
    }

    pub fn truncate_local(&self, size: i64) {
        let mut inner = self.inner.lock();
        inner.size = size;
        let first_removed = (size + CHUNK_SIZE as i64 - 1) / CHUNK_SIZE as i64;
        inner.dirty.retain(|index, _| *index < first_removed);
        if size > 0 && size % CHUNK_SIZE as i64 != 0 {
            let retained = size / CHUNK_SIZE as i64;
            if let Some(chunk) = inner.dirty.get_mut(&retained) {
                chunk.data[(size as usize % CHUNK_SIZE)..].fill(0);
            }
        }
        inner.mtime_ns = now_ns();
    }

    #[must_use]
    pub fn dirty_bytes(&self) -> usize {
        self.inner
            .lock()
            .dirty
            .values()
            .filter(|chunk| chunk.sequence > 0)
            .map(|chunk| chunk.data.len())
            .sum()
    }

    #[must_use]
    pub fn size(&self) -> i64 {
        self.inner.lock().size
    }

    #[must_use]
    pub fn mtime_ns(&self) -> i64 {
        self.inner.lock().mtime_ns
    }

    #[must_use]
    pub fn has_dirty_data(&self) -> bool {
        self.inner
            .lock()
            .dirty
            .values()
            .any(|chunk| chunk.sequence > 0)
    }

    pub fn record_error(&self, error: impl ToString) {
        let mut inner = self.inner.lock();
        if inner.writeback_error.is_none() {
            inner.writeback_error = Some(error.to_string());
        }
    }

    #[must_use]
    pub fn writeback_error(&self) -> Option<String> {
        self.inner.lock().writeback_error.clone()
    }

    pub fn discard_dirty_as_error(&self, reason: &str) {
        let mut inner = self.inner.lock();
        if !inner.dirty.is_empty() {
            inner.dirty.clear();
            if inner.writeback_error.is_none() {
                inner.writeback_error = Some(reason.to_string());
            }
        }
    }
}

#[derive(Default)]
pub struct DirtyCache {
    inodes: DashMap<i64, Arc<InodeState>>,
}

impl DirtyCache {
    pub fn state_for(&self, node: &Node) -> Arc<InodeState> {
        Arc::clone(
            self.inodes
                .entry(node.node_id)
                .or_insert_with(|| Arc::new(InodeState::new(node)))
                .value(),
        )
    }

    pub fn existing(&self, node_id: i64) -> Option<Arc<InodeState>> {
        self.inodes
            .get(&node_id)
            .map(|value| Arc::clone(value.value()))
    }

    pub fn states(&self) -> Vec<Arc<InodeState>> {
        self.inodes
            .iter()
            .map(|entry| Arc::clone(entry.value()))
            .collect()
    }

    #[must_use]
    pub fn dirty_bytes(&self) -> usize {
        self.inodes.iter().map(|entry| entry.dirty_bytes()).sum()
    }

    pub fn first_error(&self) -> Option<String> {
        self.inodes.iter().find_map(|entry| entry.writeback_error())
    }

    pub fn discard_all_as_error(&self, reason: &str) {
        for state in self.states() {
            state.discard_dirty_as_error(reason);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DirectoryEntry, NodeKind};

    fn node() -> Node {
        Node {
            node_id: 2,
            kind: NodeKind::File,
            mode: 0o644,
            uid: 1000,
            gid: 1000,
            size: 0,
            nlink: 1,
            atime_ns: 0,
            mtime_ns: 0,
            ctime_ns: 0,
            symlink_target: None,
            deleted: false,
        }
    }

    #[test]
    fn commit_does_not_clear_a_chunk_modified_after_snapshot() {
        let state = InodeState::new(&node());
        state.inner.lock().dirty.insert(
            0,
            DirtyChunk {
                data: vec![0; CHUNK_SIZE],
                sequence: 1,
            },
        );
        {
            let mut inner = state.inner.lock();
            inner.next_sequence = 2;
            inner.size = CHUNK_SIZE as i64;
        }
        let snapshot = state.snapshot().unwrap();
        state.write(0, b"new").unwrap();
        state.committed(&snapshot);
        assert_eq!(state.dirty_bytes(), CHUNK_SIZE);
    }

    #[test]
    fn truncate_drops_dirty_chunks_beyond_eof() {
        let state = InodeState::new(&node());
        for index in 0..3 {
            state.inner.lock().dirty.insert(
                index,
                DirtyChunk {
                    data: vec![1; CHUNK_SIZE],
                    sequence: 1,
                },
            );
        }
        state.truncate_local((CHUNK_SIZE + 10) as i64);
        assert_eq!(state.dirty_bytes(), CHUNK_SIZE * 2);
        assert!(state.inner.lock().dirty[&1].data[10..]
            .iter()
            .all(|byte| *byte == 0));
    }

    #[test]
    fn snapshot_omits_clean_preload_and_trims_the_last_chunk() {
        let state = InodeState::new(&node());
        state.inner.lock().dirty.insert(
            0,
            DirtyChunk {
                data: vec![0; CHUNK_SIZE],
                sequence: 0,
            },
        );
        assert!(state.snapshot().is_none());
        assert_eq!(state.dirty_bytes(), 0);

        state.inner.lock().next_sequence = 1;
        state.write(0, b"small").unwrap();
        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].data, b"small");
    }

    #[test]
    fn metadata_directory_snapshot_caches_hits_and_authoritative_misses() {
        let cache = MetadataCache::default();
        let generation = cache.generation();
        cache.remember_directory(
            generation,
            1,
            Arc::new(vec![DirectoryEntry {
                name: b"project".to_vec(),
                node: node(),
            }]),
        );

        assert!(matches!(
            cache.lookup(1, b"project"),
            Some(CachedLookup::Found(found)) if found.node_id == 2
        ));
        assert!(matches!(
            cache.lookup(1, b"missing"),
            Some(CachedLookup::Missing)
        ));
    }

    #[test]
    fn metadata_invalidation_rejects_a_late_remote_result() {
        let cache = MetadataCache::default();
        let stale_generation = cache.generation();
        cache.invalidate();
        cache.remember_node(stale_generation, node());

        assert!(cache.node(2).is_none());
        assert!(cache.lookup(1, b"anything").is_none());
    }
}
