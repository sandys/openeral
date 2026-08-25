export const OPENRIND_DESKTOP_DEPLOYMENT_ENV_VAR = "VITE_OPENRIND_DESKTOP_DEPLOYMENT";

export type OpenrindDesktopDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): OpenrindDesktopDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getOpenrindDesktopDeployment(): OpenrindDesktopDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OPENRIND_DESKTOP_DEPLOYMENT === "string"
      ? import.meta.env.VITE_OPENRIND_DESKTOP_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getOpenrindDesktopDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getOpenrindDesktopDeployment() === "desktop";
}
