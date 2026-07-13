import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");

const ensureTmp = async () => {
  await mkdir(tmpDir, { recursive: true });
};

const isPortFree = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });

const getFreePort = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const resolvePort = async (value: string | undefined, host: string) => {
  if (value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      const free = await isPortFree(parsed, host);
      if (free) return parsed;
    }
  }
  return await getFreePort(host);
};

const logLine = (message: string) => {
  process.stdout.write(`${message}\n`);
};

const readBool = (value: string | undefined) => {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const silent = process.argv.includes("--silent");

const autoBuildEnabled =
  process.env.OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD == null
    ? true
    : readBool(process.env.OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD);

const runCommand = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: silent ? "ignore" : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });

const spawnLogged = (
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
) => {
  const logFd = openSync(logPath, "w");
  return spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", logFd, logFd],
  });
};

const shutdown = (
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) => {
  const reason =
    code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
  logLine(`[dev:headless-web] ${label} exited (${reason})`);
  process.exit(code ?? 1);
};

await ensureTmp();

const remoteAccessEnabled = readBool(process.env.OPENRIND_DESKTOP_REMOTE_ACCESS);
const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
const viteHost = process.env.VITE_HOST ?? process.env.HOST ?? host;
const publicHost = process.env.OPENRIND_DESKTOP_PUBLIC_HOST ?? null;
const clientHost = publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
const workspace = process.env.OPENRIND_DESKTOP_WORKSPACE ?? cwd;
const openrindDesktopPort = await resolvePort(process.env.OPENRIND_DESKTOP_PORT, "127.0.0.1");
const webPort = await resolvePort(process.env.OPENRIND_DESKTOP_WEB_PORT, "127.0.0.1");
const openrindDesktopToken = process.env.OPENRIND_DESKTOP_TOKEN ?? randomUUID();
const openrindDesktopHostToken = process.env.OPENRIND_DESKTOP_HOST_TOKEN ?? randomUUID();
const openrindDesktopServerBin = path.join(
  cwd,
  "apps/server/dist/bin/openrind-desktop-server",
);
const opencodeRouterBin = path.join(
  cwd,
  "apps/opencode-router/dist/bin/opencode-router",
);

const ensureOpenrindDesktopServer = async () => {
  try {
    await access(openrindDesktopServerBin);
  } catch {
    if (!autoBuildEnabled) {
      logLine(
        `[dev:headless-web] Missing Openrind Desktop server binary at ${openrindDesktopServerBin}`,
      );
      logLine(
        "[dev:headless-web] Auto-build disabled (OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD=0)",
      );
      logLine(
        "[dev:headless-web] Run: pnpm --filter openrind-desktop-server build:bin",
      );
      logLine(
        "[dev:headless-web] Or unset/enable OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD to auto-build.",
      );
      process.exit(1);
    }

    logLine(
      `[dev:headless-web] Missing Openrind Desktop server binary at ${openrindDesktopServerBin}`,
    );
    logLine(
      "[dev:headless-web] Auto-building: pnpm --filter openrind-desktop-server build:bin",
    );
    try {
      await runCommand("pnpm", ["--filter", "openrind-desktop-server", "build:bin"]);
      await access(openrindDesktopServerBin);
    } catch (error) {
      logLine(
        `[dev:headless-web] Auto-build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }
};

const ensureOpencodeRouter = async () => {
  try {
    await access(opencodeRouterBin);
  } catch {
    if (!autoBuildEnabled) {
      logLine(
        `[dev:headless-web] Missing opencode-router binary at ${opencodeRouterBin}`,
      );
      logLine(
        "[dev:headless-web] Auto-build disabled (OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD=0)",
      );
      logLine(
        "[dev:headless-web] Run: pnpm --filter opencode-router build:bin",
      );
      logLine(
        "[dev:headless-web] Or unset/enable OPENRIND_DESKTOP_DEV_HEADLESS_WEB_AUTOBUILD to auto-build.",
      );
      process.exit(1);
    }

    logLine(
      `[dev:headless-web] Missing opencode-router binary at ${opencodeRouterBin}`,
    );
    logLine(
      "[dev:headless-web] Auto-building: pnpm --filter opencode-router build:bin",
    );
    try {
      await runCommand("pnpm", ["--filter", "opencode-router", "build:bin"]);
      await access(opencodeRouterBin);
    } catch (error) {
      logLine(
        `[dev:headless-web] Auto-build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }
};

const openrindDesktopUrl = `http://${clientHost}:${openrindDesktopPort}`;
const webUrl = `http://${clientHost}:${webPort}`;
// In practice we want opencode-router on for end-to-end messaging tests.
// Allow opt-out via OPENRIND_DESKTOP_DEV_OPENCODE_ROUTER=0.
const opencodeRouterEnabled =
  process.env.OPENRIND_DESKTOP_DEV_OPENCODE_ROUTER == null
    ? true
    : readBool(process.env.OPENRIND_DESKTOP_DEV_OPENCODE_ROUTER);
const opencodeRouterRequired = readBool(
  process.env.OPENRIND_DESKTOP_DEV_OPENCODE_ROUTER_REQUIRED,
);
const viteEnv = {
  ...process.env,
  HOST: viteHost,
  PORT: String(webPort),
  VITE_OPENRIND_DESKTOP_URL: process.env.VITE_OPENRIND_DESKTOP_URL ?? openrindDesktopUrl,
  VITE_OPENRIND_DESKTOP_PORT: process.env.VITE_OPENRIND_DESKTOP_PORT ?? String(openrindDesktopPort),
  VITE_OPENRIND_DESKTOP_TOKEN: process.env.VITE_OPENRIND_DESKTOP_TOKEN ?? openrindDesktopToken,
};
const headlessEnv = {
  ...process.env,
  OPENRIND_DESKTOP_WORKSPACE: workspace,
  OPENRIND_DESKTOP_HOST: host,
  OPENRIND_DESKTOP_REMOTE_ACCESS: remoteAccessEnabled ? "1" : "0",
  OPENRIND_DESKTOP_PORT: String(openrindDesktopPort),
  OPENRIND_DESKTOP_TOKEN: openrindDesktopToken,
  OPENRIND_DESKTOP_HOST_TOKEN: openrindDesktopHostToken,
  OPENRIND_DESKTOP_SERVER_BIN: openrindDesktopServerBin,
  OPENRIND_DESKTOP_SIDECAR_SOURCE: process.env.OPENRIND_DESKTOP_SIDECAR_SOURCE ?? "external",
  OPENCODE_ROUTER_BIN: process.env.OPENCODE_ROUTER_BIN ?? opencodeRouterBin,
};

await ensureOpenrindDesktopServer();
if (opencodeRouterEnabled) {
  await ensureOpencodeRouter();
}

logLine("[dev:headless-web] Starting services");
logLine(`[dev:headless-web] Workspace: ${workspace}`);
logLine(`[dev:headless-web] Openrind Desktop server: ${openrindDesktopUrl}`);
logLine(`[dev:headless-web] Web host: ${viteHost}`);
logLine(`[dev:headless-web] Web port: ${webPort}`);
logLine(`[dev:headless-web] Web URL: ${webUrl}`);
logLine(
  `[dev:headless-web] OpenCodeRouter: ${opencodeRouterEnabled ? "on" : "off"} (set OPENRIND_DESKTOP_DEV_OPENCODE_ROUTER=0 to disable)`,
);
logLine("[dev:headless-web] OPENRIND_DESKTOP_TOKEN: [REDACTED]");
logLine("[dev:headless-web] OPENRIND_DESKTOP_HOST_TOKEN: [REDACTED]");
logLine(
  `[dev:headless-web] Web logs: ${path.relative(cwd, path.join(tmpDir, "dev-web.log"))}`,
);
logLine(
  `[dev:headless-web] Headless logs: ${path.relative(cwd, path.join(tmpDir, "dev-headless.log"))}`,
);

const webProcess = spawnLogged(
  "pnpm",
  [
    "--filter",
    "@openrind/app",
    "exec",
    "vite",
    "--host",
    viteHost,
    "--port",
    String(webPort),
    "--strictPort",
  ],
  path.join(tmpDir, "dev-web.log"),
  viteEnv,
);

const headlessProcess = spawnLogged(
  "pnpm",
  [
    "--filter",
    "openrind-desktop-orchestrator",
    "dev",
    "--",
    "start",
    "--workspace",
    workspace,
    "--approval",
    "auto",
    "--allow-external",
    "--opencode-router",
    opencodeRouterEnabled ? "true" : "false",
    ...(opencodeRouterRequired ? ["--opencode-router-required"] : []),
    ...(remoteAccessEnabled ? ["--remote-access"] : []),
    "--openrind-desktop-port",
    String(openrindDesktopPort),
  ],
  path.join(tmpDir, "dev-headless.log"),
  headlessEnv,
);

const stopAll = (signal: NodeJS.Signals) => {
  webProcess.kill(signal);
  headlessProcess.kill(signal);
};

process.on("SIGINT", () => {
  stopAll("SIGINT");
});
process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});

webProcess.on("exit", (code, signal) => shutdown("web", code, signal));
headlessProcess.on("exit", (code, signal) =>
  shutdown("orchestrator", code, signal),
);
