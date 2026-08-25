import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

let writeQueue = Promise.resolve();

function redact(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:ant|or)-[A-Za-z0-9_-]+\b/gi, "[REDACTED_API_KEY]")
    .replace(
      /\b(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /\b((?:ANTHROPIC_API_KEY|DATABASE_URL|POSTGRES_URL|SOCKET_TOKEN|OPENRIND_GATEWAY_API_KEY)\s*[=:]\s*)[^\s'\"]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:password|token|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
}

function errorDetails(error) {
  if (error instanceof Error) {
    const details = {
      name: error.name,
      message: redact(error.message),
      stack: redact(error.stack || ""),
    };
    if (error.cause !== undefined) details.cause = errorDetails(error.cause);
    return details;
  }
  return { message: redact(error) };
}

/**
 * Append one internal Claude launch failure. Callers pass only identifiers;
 * credentials and arbitrary IPC arguments must never be written here.
 */
export function appendClaudeLaunchError({ logPath, command, context, error }) {
  const entry = {
    timestamp: new Date().toISOString(),
    command: String(command || "unknown"),
    context: {
      sandboxName: String(context?.sandboxName || ""),
      workspaceId: String(context?.workspaceId || ""),
      profile: String(context?.profile || ""),
      sessionId: String(context?.sessionId || ""),
    },
    error: errorDetails(error),
  };
  const record = `${JSON.stringify(entry, null, 2)}\n\n`;

  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, record, { encoding: "utf8", mode: 0o600 });
    });
  return writeQueue;
}

