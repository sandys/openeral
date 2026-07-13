import packageJson from "../package.json" with { type: "json" };

declare const __OPENRIND_DESKTOP_SERVER_V2_VERSION__: string | undefined;

function normalizeVersion(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export function resolveServerV2Version() {
  return (
    normalizeVersion(process.env.OPENRIND_DESKTOP_SERVER_V2_VERSION) ??
    normalizeVersion(
      typeof __OPENRIND_DESKTOP_SERVER_V2_VERSION__ === "string"
        ? __OPENRIND_DESKTOP_SERVER_V2_VERSION__
        : null,
    ) ??
    normalizeVersion(packageJson.version) ??
    "0.0.0"
  );
}
