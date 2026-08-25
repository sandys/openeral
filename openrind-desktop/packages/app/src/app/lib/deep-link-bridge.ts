export const deepLinkBridgeEvent = "openrind-desktop:deep-link";
export const nativeDeepLinkEvent = "openrind-desktop:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __OPENRIND_DESKTOP__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.map((url) => url.trim()).filter(Boolean);
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__OPENRIND_DESKTOP__ ??= {};
  const pending = target.__OPENRIND_DESKTOP__.deepLinks ?? [];
  target.__OPENRIND_DESKTOP__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__OPENRIND_DESKTOP__?.deepLinks ?? [];
  if (target.__OPENRIND_DESKTOP__) {
    target.__OPENRIND_DESKTOP__.deepLinks = [];
  }
  return [...pending];
}
