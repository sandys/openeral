import { DEFAULT_DEN_BASE_URL, normalizeDenBaseUrl } from "./den";
import { normalizeOpenrindDesktopServerUrl } from "./openrind-desktop-server";
import {
  normalizeBundleImportIntent,
  parseBundleDeepLink,
} from "../bundles/sources";
import type { BundleRequest } from "../bundles/types";

export type RemoteWorkspaceDefaults = {
  openrindDesktopHostUrl?: string | null;
  openrindDesktopToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  autoConnect?: boolean;
};

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

// SECURITY FIX: Updated to use secure token exchange instead of plaintext API keys
export type GatewayAuthDeepLink = {
  token: string;        // Secure one-time exchange token (NEW)
  apiKey?: string;      // Legacy field for backward compatibility (deprecated)
  status: string;
  email?: string;
  name?: string;
};

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return (
    normalized === "openrind-desktop:" ||
    normalized === "openrind-desktop-dev:" ||
    normalized === "https:" ||
    normalized === "http:"
  );
}

export function parseRemoteConnectDeepLink(
  rawUrl: string,
): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (
    routeHost !== "connect-remote" &&
    routePath !== "connect-remote" &&
    routeTail !== "connect-remote"
  ) {
    return null;
  }

  const hostUrlRaw =
    url.searchParams.get("openrindDesktopHostUrl") ??
    url.searchParams.get("openrindDesktopUrl") ??
    "";
  const tokenRaw =
    url.searchParams.get("openrindDesktopToken") ??
    url.searchParams.get("accessToken") ??
    "";
  const normalizedHostUrl = normalizeOpenrindDesktopServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName =
    workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");

  // SECURITY: never honor autoConnect / bypassModal / bypassAddWorkerModal from
  // an untrusted deep link. A single crafted link (deliverable even as an
  // ordinary web URL that opens the app, or via a malicious page setting the
  // location on web) would otherwise silently point the user's worker at an
  // attacker-operated host with an attacker-chosen token, skipping the connect
  // confirmation. The parsed values only PREFILL the connect modal; the user
  // must always explicitly confirm.
  return {
    openrindDesktopHostUrl: normalizedHostUrl,
    openrindDesktopToken: token,
    directory: null,
    displayName: displayName || null,
    autoConnect: false,
  };
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "openrindDesktopHostUrl",
    "openrindDesktopUrl",
    "openrindDesktopToken",
    "accessToken",
    "workerId",
    "workerName",
    "autoConnect",
    "bypassModal",
    "bypassAddWorkerModal",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

/**
 * SECURITY FIX: Parse gateway auth deep link with secure token exchange
 * 
 * Now accepts EITHER:
 * - token (NEW, secure): one-time exchange token that must be exchanged via API
 * - api_key (DEPRECATED): plaintext API key for backward compatibility
 * 
 * The token flow is preferred and secure:
 * 1. Web generates random token and encrypts API key
 * 2. Desktop receives token (not the key)
 * 3. Desktop exchanges token for actual key via HTTPS POST
 * 4. Token auto-expires and is deleted after use
 */
export function parseGatewayAuthDeepLink(rawUrl: string): GatewayAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  // Restrict to secure registered desktop schemes only (prevent http/https browser injection attacks)
  if (protocol !== "openrind-desktop:" && protocol !== "openrind-desktop-dev:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";

  if (
    routeHost !== "auth" &&
    routePath !== "auth" &&
    routeTail !== "auth"
  ) {
    return null;
  }

  // SECURITY: Prefer token (secure) over api_key (legacy, insecure)
  const token = url.searchParams.get("token")?.trim() ?? "";
  const apiKey = url.searchParams.get("api_key")?.trim() ?? ""; // Legacy support
  
  const rawStatus = url.searchParams.get("status")?.trim();
  const status = rawStatus === "paid" ? "paid" : "unpaid"; // Validate exact allowed statuses, default to "unpaid"
  const email = url.searchParams.get("email")?.trim() ?? "";
  const name = url.searchParams.get("name")?.trim() ?? "";

  // Require EITHER token OR api_key (prefer token)
  if (!token && !apiKey) {
    return null;
  }

  // Return token if present (secure flow), otherwise api_key (legacy flow)
  if (token) {
    return { token, status, email, name };
  } else {
    // Legacy: api_key in URL (DEPRECATED but supported for backward compatibility)
    return { token: "", apiKey, status, email, name };
  }
}

export function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (
    routeHost !== "den-auth" &&
    routePath !== "den-auth" &&
    routeTail !== "den-auth"
  ) {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl =
    normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
    DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return { grant, denBaseUrl };
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(
    /(?:openrind-desktop-dev|openrind-desktop|https?):\/\/[^\s"'<>]+/i,
  );
  if (directMatch) return directMatch[0];

  const bareShareMatch = trimmed.match(
    /share\.openrind-desktop(?:labs\.com|\.software)\/b\/[^\s"'<>]+/i,
  );
  if (bareShareMatch) return `https://${bareShareMatch[0]}`;

  return trimmed;
}

export function parseDebugDeepLinkInput(
  rawValue: string,
):
  | { kind: "bundle"; link: BundleRequest }
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const bundleLink = parseBundleDeepLink(normalized);
  if (bundleLink) {
    return { kind: "bundle", link: bundleLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  const bundleMatch = normalized.match(/ow_bundle=([^&\s]+)/i);
  if (bundleMatch?.[1]) {
    try {
      const bundleUrl = decodeURIComponent(bundleMatch[1]);
      const intentMatch = normalized.match(/(?:ow_intent|intent)=([^&\s]+)/i);
      const labelMatch = normalized.match(/ow_label=([^&\s]+)/i);
      const sourceMatch = normalized.match(/(?:ow_source|source)=([^&\s]+)/i);
      return {
        kind: "bundle",
        link: {
          bundleUrl,
          intent: normalizeBundleImportIntent(
            intentMatch?.[1] ? decodeURIComponent(intentMatch[1]) : undefined,
          ),
          label: labelMatch?.[1]
            ? decodeURIComponent(labelMatch[1])
            : undefined,
          source: sourceMatch?.[1]
            ? decodeURIComponent(sourceMatch[1])
            : undefined,
        },
      };
    } catch {
      // ignore fallback parsing errors
    }
  }

  const shareIdMatch = normalized.match(
    /share\.openrind-desktop(?:labs\.com|\.software)\/b\/([^\s/?#"'<>]+)/i,
  );
  if (shareIdMatch?.[1]) {
    return {
      kind: "bundle",
      link: {
        bundleUrl: `https://share.openrind-desktoplabs.com/b/${shareIdMatch[1]}`,
        intent: "new_worker",
      },
    };
  }

  return null;
}
