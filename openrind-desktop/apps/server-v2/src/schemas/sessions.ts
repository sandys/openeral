import { z } from "zod";
import { identifierSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const sessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
]).meta({ ref: "OpenrindDesktopServerV2SessionStatus" });

const sessionTimeSchema = z.object({
  archived: z.number().optional(),
  completed: z.number().optional(),
  created: z.number().optional(),
  updated: z.number().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionTime" });

const sessionSummarySchema = z.object({
  additions: z.number().optional(),
  deletions: z.number().optional(),
  files: z.number().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionSummary" });

export const sessionSchema = z.object({
  directory: z.string().nullish(),
  id: identifierSchema,
  parentID: z.string().nullish(),
  revert: z.object({
    messageID: identifierSchema,
  }).partial().nullish(),
  slug: z.string().nullish(),
  summary: sessionSummarySchema.optional(),
  time: sessionTimeSchema.optional(),
  title: z.string().nullish(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2Session" });

const sessionMessageInfoSchema = z.object({
  id: identifierSchema,
  parentID: z.string().nullish(),
  role: z.string(),
  sessionID: identifierSchema,
  time: sessionTimeSchema.optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionMessageInfo" });

export const sessionMessagePartSchema = z.object({
  id: identifierSchema,
  messageID: identifierSchema,
  sessionID: identifierSchema,
  type: z.string().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionMessagePart" });

export const sessionMessageSchema = z.object({
  info: sessionMessageInfoSchema,
  parts: z.array(sessionMessagePartSchema),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionMessage" });

export const sessionTodoSchema = z.object({
  content: z.string(),
  priority: z.string(),
  status: z.string(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionTodo" });

export const sessionSnapshotSchema = z.object({
  messages: z.array(sessionMessageSchema),
  session: sessionSchema,
  status: sessionStatusSchema,
  todos: z.array(sessionTodoSchema),
}).meta({ ref: "OpenrindDesktopServerV2SessionSnapshot" });

export const workspaceEventSchema = z.object({
  properties: z.unknown().optional(),
  type: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceEvent" });

export const sessionListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  roots: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).optional(),
  start: z.coerce.number().int().nonnegative().optional(),
}).meta({ ref: "OpenrindDesktopServerV2SessionListQuery" });

export const sessionMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
}).meta({ ref: "OpenrindDesktopServerV2SessionMessagesQuery" });

export const sessionIdParamsSchema = workspaceIdParamsSchema.extend({
  sessionId: identifierSchema.describe("Stable session identifier within the resolved workspace backend."),
}).meta({ ref: "OpenrindDesktopServerV2SessionIdParams" });

export const messageIdParamsSchema = sessionIdParamsSchema.extend({
  messageId: identifierSchema.describe("Stable message identifier within the resolved session."),
}).meta({ ref: "OpenrindDesktopServerV2MessageIdParams" });

export const messagePartParamsSchema = messageIdParamsSchema.extend({
  partId: identifierSchema.describe("Stable message part identifier within the resolved message."),
}).meta({ ref: "OpenrindDesktopServerV2MessagePartParams" });

export const sessionCreateRequestSchema = z.object({
  parentSessionId: identifierSchema.optional(),
  title: z.string().trim().min(1).max(300).optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionCreateRequest" });

export const sessionUpdateRequestSchema = z.object({
  archived: z.boolean().optional(),
  title: z.string().trim().min(1).max(300).optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionUpdateRequest" });

export const sessionForkRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionForkRequest" });

export const sessionSummarizeRequestSchema = z.object({
  modelID: z.string().trim().min(1).optional(),
  providerID: z.string().trim().min(1).optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2SessionSummarizeRequest" });

export const messageSendRequestSchema = z.object({
  parts: z.array(z.unknown()).optional(),
  role: z.string().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2MessageSendRequest" });

export const promptAsyncRequestSchema = z.object({
  agent: z.string().optional(),
  messageID: identifierSchema.optional(),
  model: z.object({
    modelID: z.string(),
    providerID: z.string(),
  }).optional(),
  noReply: z.boolean().optional(),
  parts: z.array(z.unknown()).optional(),
  reasoning_effort: z.string().optional(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  variant: z.string().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2PromptAsyncRequest" });

export const commandRequestSchema = z.object({
  agent: z.string().optional(),
  arguments: z.string().optional(),
  command: z.string().min(1),
  messageID: identifierSchema.optional(),
  model: z.string().optional(),
  parts: z.array(z.unknown()).optional(),
  reasoning_effort: z.string().optional(),
  variant: z.string().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2CommandRequest" });

export const shellRequestSchema = z.object({
  command: z.string().min(1),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2ShellRequest" });

export const revertRequestSchema = z.object({
  messageID: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2RevertRequest" });

export const messagePartUpdateRequestSchema = z.object({
  text: z.string().optional(),
}).passthrough().meta({ ref: "OpenrindDesktopServerV2MessagePartUpdateRequest" });

export const sessionListDataSchema = z.object({
  items: z.array(sessionSchema),
}).meta({ ref: "OpenrindDesktopServerV2SessionListData" });

export const sessionStatusesDataSchema = z.object({
  items: z.record(z.string(), sessionStatusSchema),
}).meta({ ref: "OpenrindDesktopServerV2SessionStatusesData" });

export const sessionTodoListDataSchema = z.object({
  items: z.array(sessionTodoSchema),
}).meta({ ref: "OpenrindDesktopServerV2SessionTodoListData" });

export const messageListDataSchema = z.object({
  items: z.array(sessionMessageSchema),
}).meta({ ref: "OpenrindDesktopServerV2MessageListData" });

export const acceptedActionDataSchema = z.object({
  accepted: z.literal(true),
}).meta({ ref: "OpenrindDesktopServerV2AcceptedActionData" });

export const deletedActionDataSchema = z.object({
  deleted: z.literal(true),
}).meta({ ref: "OpenrindDesktopServerV2DeletedActionData" });

export const sessionResponseSchema = successResponseSchema("OpenrindDesktopServerV2SessionResponse", sessionSchema);
export const sessionListResponseSchema = successResponseSchema("OpenrindDesktopServerV2SessionListResponse", sessionListDataSchema);
export const sessionStatusesResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SessionStatusesResponse",
  sessionStatusesDataSchema,
);
export const sessionStatusResponseSchema = successResponseSchema("OpenrindDesktopServerV2SessionStatusResponse", sessionStatusSchema);
export const sessionTodoListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SessionTodoListResponse",
  sessionTodoListDataSchema,
);
export const sessionSnapshotResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SessionSnapshotResponse",
  sessionSnapshotSchema,
);
export const messageResponseSchema = successResponseSchema("OpenrindDesktopServerV2MessageResponse", sessionMessageSchema);
export const messageListResponseSchema = successResponseSchema("OpenrindDesktopServerV2MessageListResponse", messageListDataSchema);
export const acceptedActionResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2AcceptedActionResponse",
  acceptedActionDataSchema,
);
export const deletedActionResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2DeletedActionResponse",
  deletedActionDataSchema,
);

export type SessionRecord = z.infer<typeof sessionSchema>;
export type SessionMessageRecord = z.infer<typeof sessionMessageSchema>;
export type SessionSnapshotRecord = z.infer<typeof sessionSnapshotSchema>;
export type SessionStatusRecord = z.infer<typeof sessionStatusSchema>;
export type SessionTodoRecord = z.infer<typeof sessionTodoSchema>;
export type WorkspaceEventRecord = z.infer<typeof workspaceEventSchema>;

export function parseSessionData(value: unknown) {
  return sessionSchema.parse(value);
}

export function parseSessionListData(value: unknown) {
  return z.array(sessionSchema).parse(value);
}

export function parseSessionMessageData(value: unknown) {
  return sessionMessageSchema.parse(value);
}

export function parseSessionMessagesData(value: unknown) {
  return z.array(sessionMessageSchema).parse(value);
}

export function parseSessionStatusesData(value: unknown) {
  return z.record(z.string(), sessionStatusSchema).parse(value);
}

export function parseSessionTodosData(value: unknown) {
  return z.array(sessionTodoSchema).parse(value);
}

export function parseWorkspaceEventData(value: unknown) {
  return workspaceEventSchema.parse(value);
}
