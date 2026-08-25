import { normalizeServerBaseUrl } from "../client.js";
import type { OpenrindDesktopServerV2WorkspaceEvent } from "../../generated/types.gen";
import {
  createOpenrindDesktopServerEventStream,
  type OpenrindDesktopServerEventStreamOptions,
  type OpenrindDesktopServerEventStreamResult,
} from "./sse.js";

export type OpenrindDesktopServerWorkspaceEvent = OpenrindDesktopServerV2WorkspaceEvent;

export type OpenrindDesktopServerWorkspaceEventStreamOptions = Omit<
  OpenrindDesktopServerEventStreamOptions<OpenrindDesktopServerWorkspaceEvent>,
  "url"
> & {
  baseUrl: string;
  workspaceId: string;
};

export type OpenrindDesktopServerWorkspaceEventStreamResult = OpenrindDesktopServerEventStreamResult<OpenrindDesktopServerWorkspaceEvent>;

export function createOpenrindDesktopServerWorkspaceEventStream(
  options: OpenrindDesktopServerWorkspaceEventStreamOptions,
): OpenrindDesktopServerWorkspaceEventStreamResult {
  const baseUrl = normalizeServerBaseUrl(options.baseUrl);
  const url = `${baseUrl}/workspaces/${encodeURIComponent(options.workspaceId)}/events`;
  return createOpenrindDesktopServerEventStream<OpenrindDesktopServerWorkspaceEvent>({
    ...options,
    url,
  });
}
