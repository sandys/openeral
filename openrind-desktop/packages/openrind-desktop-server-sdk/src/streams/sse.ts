import { createSseClient } from "../../generated/core/serverSentEvents.gen";
import type { ServerSentEventsOptions, ServerSentEventsResult, StreamEvent } from "../../generated/core/serverSentEvents.gen";

export type OpenrindDesktopServerEventStreamOptions<TData = unknown> = ServerSentEventsOptions<TData>;
export type OpenrindDesktopServerEventStreamResult<TData = unknown> = ServerSentEventsResult<TData>;
export type OpenrindDesktopServerStreamEvent<TData = unknown> = StreamEvent<TData>;

export function createOpenrindDesktopServerEventStream<TData = unknown>(options: OpenrindDesktopServerEventStreamOptions<TData>) {
  return createSseClient<TData>(options as ServerSentEventsOptions<unknown>) as OpenrindDesktopServerEventStreamResult<TData>;
}
