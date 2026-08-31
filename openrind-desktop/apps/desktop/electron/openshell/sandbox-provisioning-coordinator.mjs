/**
 * Keep ownership of long-running sandbox provisioning in the Electron/main
 * layer. Renderer navigation may abandon its IPC response, but it must never
 * start a competing create that deletes the container currently being built.
 *
 * Calls for the same sandbox/profile join one promise. A profile change for the
 * same sandbox is serialized behind the active operation because changing the
 * agent profile may legitimately require replacing the container.
 */
export function createSandboxProvisioningCoordinator() {
  /** @type {Map<string, {
   *   profile: string,
   *   promise: Promise<unknown>,
   *   lastProgress: unknown,
   *   progressSink?: ((event: unknown) => void),
   * }>} */
  const active = new Map();

  function run({ sandboxName, profile, provision, onProgress }) {
    const key = String(sandboxName ?? "").trim();
    const variant = String(profile ?? "").trim();
    if (!key) return Promise.reject(new Error("sandboxName is required"));
    if (!variant) return Promise.reject(new Error("profile is required"));
    if (typeof provision !== "function") {
      return Promise.reject(new Error("provision must be a function"));
    }

    const current = active.get(key);
    if (current) {
      if (current.profile !== variant) {
        // Never let two profiles mutate/delete the same sandbox concurrently.
        return current.promise
          .catch(() => undefined)
          .then(() => run({ sandboxName: key, profile: variant, provision, onProgress }));
      }

      // A newly mounted view takes over the progress sink and immediately gets
      // the most recent activity. Main-process progress sinks are independent
      // of the renderer component that initiated the IPC call.
      if (typeof onProgress === "function") {
        current.progressSink = onProgress;
        if (current.lastProgress !== null) {
          try {
            onProgress(current.lastProgress);
          } catch {
            // Progress reporting is observational and must not fail provisioning.
          }
        }
      }
      return current.promise;
    }

    const entry = {
      profile: variant,
      promise: null,
      lastProgress: null,
      progressSink: typeof onProgress === "function" ? onProgress : undefined,
    };
    const reportProgress = (event) => {
      entry.lastProgress = event;
      try {
        entry.progressSink?.(event);
      } catch {
        // Progress reporting is observational and must not fail provisioning.
      }
    };

    // Defer the task by one microtask so the entry is installed before any
    // synchronous work/progress begins. That closes the same-tick double-start
    // race as well as the longer navigation/remount race.
    entry.promise = Promise.resolve().then(() => provision(reportProgress));
    active.set(key, entry);
    const release = () => {
      if (active.get(key) === entry) active.delete(key);
    };
    void entry.promise.then(release, release);
    return entry.promise;
  }

  return {
    run,
    isProvisioning(sandboxName) {
      return active.has(String(sandboxName ?? "").trim());
    },
  };
}
