import { z } from "zod";
import { identifierSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const fileSessionIdParamsSchema = workspaceIdParamsSchema.extend({
  fileSessionId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2FileSessionIdParams" });

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const workspaceActivationDataSchema = z.object({
  activeWorkspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceActivationData" });

export const engineReloadDataSchema = z.object({
  reloadedAt: z.number().int().nonnegative(),
}).meta({ ref: "OpenrindDesktopServerV2EngineReloadData" });

export const workspaceDeleteDataSchema = z.object({
  deleted: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceDeleteData" });

export const workspaceDisposeDataSchema = z.object({
  disposed: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceDisposeData" });

export const workspaceCreateLocalRequestSchema = z.object({
  folderPath: z.string().min(1),
  name: z.string().min(1),
  preset: z.string().min(1).optional(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceCreateLocalRequest" });

export const reloadEventSchema = z.object({
  id: identifierSchema,
  reason: z.enum(["agents", "commands", "config", "mcp", "plugins", "skills"]),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  trigger: z.object({
    action: z.enum(["added", "removed", "updated"]).optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    type: z.enum(["agent", "command", "config", "mcp", "plugin", "skill"]),
  }).optional(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2ReloadEvent" });

export const reloadEventsDataSchema = z.object({
  cursor: z.number().int().nonnegative(),
  items: z.array(reloadEventSchema),
}).meta({ ref: "OpenrindDesktopServerV2ReloadEventsData" });

export const fileSessionCreateRequestSchema = z.object({
  ttlSeconds: z.number().positive().optional(),
  write: z.boolean().optional(),
}).meta({ ref: "OpenrindDesktopServerV2FileSessionCreateRequest" });

export const fileSessionDataSchema = z.object({
  canWrite: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  id: identifierSchema,
  ttlMs: z.number().int().nonnegative(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2FileSessionData" });

export const fileCatalogSnapshotSchema = z.object({
  cursor: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  items: z.array(z.object({
    kind: z.enum(["dir", "file"]),
    mtimeMs: z.number(),
    path: z.string(),
    revision: z.string(),
    size: z.number().int().nonnegative(),
  })),
  nextAfter: z.string().optional(),
  sessionId: identifierSchema,
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2FileCatalogSnapshot" });

export const fileBatchReadRequestSchema = z.object({
  paths: z.array(z.string()).min(1),
}).meta({ ref: "OpenrindDesktopServerV2FileBatchReadRequest" });

export const fileBatchReadResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2FileBatchReadResponse",
  z.object({ items: z.array(jsonRecordSchema) }),
);

export const fileBatchWriteRequestSchema = z.object({
  writes: z.array(jsonRecordSchema).min(1),
}).meta({ ref: "OpenrindDesktopServerV2FileBatchWriteRequest" });

export const fileOperationsRequestSchema = z.object({
  operations: z.array(jsonRecordSchema).min(1),
}).meta({ ref: "OpenrindDesktopServerV2FileOperationsRequest" });

export const fileMutationResultSchema = successResponseSchema(
  "OpenrindDesktopServerV2FileMutationResult",
  z.object({
    cursor: z.number().int().nonnegative(),
    items: z.array(jsonRecordSchema),
  }),
);

export const simpleContentQuerySchema = z.object({
  path: z.string().min(1),
}).meta({ ref: "OpenrindDesktopServerV2SimpleContentQuery" });

export const simpleContentWriteRequestSchema = z.object({
  baseUpdatedAt: z.number().nullable().optional(),
  content: z.string(),
  force: z.boolean().optional(),
  path: z.string().min(1),
}).meta({ ref: "OpenrindDesktopServerV2SimpleContentWriteRequest" });

export const simpleContentDataSchema = z.object({
  bytes: z.number().int().nonnegative(),
  content: z.string(),
  path: z.string(),
  revision: z.string().optional(),
  updatedAt: z.number(),
}).meta({ ref: "OpenrindDesktopServerV2SimpleContentData" });

export const binaryItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).meta({ ref: "OpenrindDesktopServerV2BinaryItem" });

export const binaryListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2BinaryListResponse",
  z.object({ items: z.array(binaryItemSchema) }),
);

export const binaryUploadDataSchema = z.object({
  bytes: z.number().int().nonnegative(),
  path: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2BinaryUploadData" });

export const workspaceActivationResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceActivationResponse",
  workspaceActivationDataSchema,
);

export const engineReloadResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2EngineReloadResponse",
  engineReloadDataSchema,
);

export const workspaceDeleteResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceDeleteResponse",
  workspaceDeleteDataSchema,
);

export const workspaceDisposeResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceDisposeResponse",
  workspaceDisposeDataSchema,
);

export const reloadEventsResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2ReloadEventsResponse",
  reloadEventsDataSchema,
);

export const fileSessionResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2FileSessionResponse",
  fileSessionDataSchema,
);

export const fileCatalogSnapshotResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2FileCatalogSnapshotResponse",
  fileCatalogSnapshotSchema,
);

export const simpleContentResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SimpleContentResponse",
  simpleContentDataSchema,
);

export const binaryUploadResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2BinaryUploadResponse",
  binaryUploadDataSchema,
);

export { fileSessionIdParamsSchema };
