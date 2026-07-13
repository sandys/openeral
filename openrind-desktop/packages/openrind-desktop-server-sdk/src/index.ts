export * from "../generated/index";
export { createClient } from "../generated/client/index";
export type {
  Client,
  ClientOptions,
  Config,
  CreateClientConfig,
  RequestOptions,
  RequestResult,
} from "../generated/client/index";
export {
  createOpenrindDesktopServerClient,
  normalizeServerBaseUrl,
  type OpenrindDesktopServerClient,
  type OpenrindDesktopServerClientConfig,
  type OpenrindDesktopServerClientFactory,
} from "./client.js";
export * from "./streams/index.js";
