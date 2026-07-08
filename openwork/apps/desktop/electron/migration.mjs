import { existsSync } from "node:fs";
import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

const MIGRATION_SNAPSHOT_FILENAME = "migration-snapshot.v1.json";
const MIGRATION_SNAPSHOT_DONE_FILENAME = "migration-snapshot.v1.done.json";

// The snapshot holds a handful of localStorage strings; anything bigger than
// this is malformed or hostile and gets ignored instead of parsed.
const MIGRATION_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

// Shape check for the fields the renderer actually consumes: version === 1
// and keys as a string -> string map (hydrated into localStorage).
function isValidSnapshot(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  if (parsed.version !== 1) return false;
  const keys = parsed.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return false;
  return Object.values(keys).every((value) => typeof value === "string");
}

function migrationSnapshotPath(app, done = false) {
  return path.join(
    app.getPath("userData"),
    done ? MIGRATION_SNAPSHOT_DONE_FILENAME : MIGRATION_SNAPSHOT_FILENAME,
  );
}

// Migration snapshot: one-way handoff from the last Tauri release into the
// first Electron launch. The Tauri shell writes migration-snapshot.v1.json
// into app_data_dir before it kicks off the Electron installer. Electron
// renders the workspace list / session-by-workspace preferences from it on
// first boot. The read consumes the snapshot (renames it .done) so a second
// window or a later boot can't re-import it.
export function registerMigrationIpc({ app, ipcMain }) {
  ipcMain.handle("openwork:migration:read", async () => {
    const snapshotPath = migrationSnapshotPath(app);
    const donePath = migrationSnapshotPath(app, true);
    if (!existsSync(snapshotPath)) return null;
    try {
      // Atomically claim the snapshot before returning its contents. When two
      // windows race, only the rename winner gets the snapshot; the loser sees
      // ENOENT and returns null, so the import can only happen once.
      await rename(snapshotPath, donePath);
    } catch (error) {
      console.warn("[migration] failed to claim snapshot", error);
      return null;
    }
    try {
      const { size } = await stat(donePath);
      if (size > MIGRATION_SNAPSHOT_MAX_BYTES) {
        console.warn("[migration] snapshot too large, ignoring", size);
        return null;
      }
      const raw = await readFile(donePath, "utf8");
      const parsed = JSON.parse(raw);
      return isValidSnapshot(parsed) ? parsed : null;
    } catch (error) {
      console.warn("[migration] failed to read snapshot", error);
      return null;
    }
  });

  // Kept for the preload contract. read already consumed the snapshot, so
  // this is normally a no-op ({ moved: false }); it only renames if a stray
  // unclaimed snapshot still exists.
  ipcMain.handle("openwork:migration:ack", async () => {
    const snapshotPath = migrationSnapshotPath(app);
    const donePath = migrationSnapshotPath(app, true);
    if (!existsSync(snapshotPath)) return { ok: true, moved: false };
    try {
      await rename(snapshotPath, donePath);
      return { ok: true, moved: true };
    } catch (error) {
      console.warn("[migration] failed to rename snapshot", error);
      return { ok: false, moved: false };
    }
  });
}
