import { execSync } from "node:child_process";

const isVercel = Boolean(process.env.VERCEL);
const command = isVercel
  ? "pnpm --dir apps/share run build"
  : "pnpm --filter @openrind/desktop build";

execSync(command, { stdio: "inherit" });
