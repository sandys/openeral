import { createClient } from "../generated/client/index";
import type { Client, Config, CreateClientConfig } from "../generated/client/index";

export type OpenrindDesktopServerClientConfig = Config;
export type OpenrindDesktopServerClient = Client;
export type OpenrindDesktopServerClientFactory = CreateClientConfig;

export function normalizeServerBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "") || baseUrl;
}

export function createOpenrindDesktopServerClient(config: OpenrindDesktopServerClientConfig = {}): OpenrindDesktopServerClient {
  return createClient({
    ...config,
    baseUrl: config.baseUrl ? normalizeServerBaseUrl(config.baseUrl) : config.baseUrl,
  });
}
