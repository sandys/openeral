/** OpenShell currently caps sandbox names at 19 characters. */
export function deriveSandboxName(workspaceId: string): string {
  const normalized = String(workspaceId ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (/^or-[a-z0-9-]{1,16}$/.test(normalized) && normalized.length <= 19) {
    return normalized;
  }
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 8) || "workspace";
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = Math.imul(hash ^ normalized.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `or-${slug}-${hash.toString(16).padStart(8, "0").slice(0, 7)}`;
}
