export type EmbeddedRuntimeBundle = {
  manifestPath: string;
  opencodePath: string;
  routerPath: string;
};

declare global {
  var __OPENRIND_DESKTOP_SERVER_V2_EMBEDDED_RUNTIME__:
    | EmbeddedRuntimeBundle
    | undefined;
}

export function registerEmbeddedRuntimeBundle(bundle: EmbeddedRuntimeBundle | undefined) {
  globalThis.__OPENRIND_DESKTOP_SERVER_V2_EMBEDDED_RUNTIME__ = bundle;
}

export function getEmbeddedRuntimeBundle() {
  return globalThis.__OPENRIND_DESKTOP_SERVER_V2_EMBEDDED_RUNTIME__ ?? null;
}
