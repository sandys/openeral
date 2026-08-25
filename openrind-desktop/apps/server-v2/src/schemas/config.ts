import { z } from "zod";
import { identifierSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const workspaceConfigSnapshotSchema = z.object({
  effective: z.object({
    opencode: jsonRecordSchema,
    openrindDesktop: jsonRecordSchema,
  }),
  materialized: z.object({
    compatibilityOpencodePath: z.string().nullable(),
    compatibilityOpenrindDesktopPath: z.string().nullable(),
    configDir: z.string().nullable(),
    configOpencodePath: z.string().nullable(),
    configOpenrindDesktopPath: z.string().nullable(),
  }),
  stored: z.object({
    opencode: jsonRecordSchema,
    openrindDesktop: jsonRecordSchema,
  }),
  updatedAt: z.string(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceConfigSnapshot" });

export const workspaceConfigPatchRequestSchema = z.object({
  opencode: jsonRecordSchema.optional(),
  openrindDesktop: jsonRecordSchema.optional(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceConfigPatchRequest" });

export const rawOpencodeConfigQuerySchema = z.object({
  scope: z.enum(["global", "project"]).optional(),
}).meta({ ref: "OpenrindDesktopServerV2RawOpencodeConfigQuery" });

export const rawOpencodeConfigWriteRequestSchema = z.object({
  content: z.string(),
  scope: z.enum(["global", "project"]).optional(),
}).meta({ ref: "OpenrindDesktopServerV2RawOpencodeConfigWriteRequest" });

export const rawOpencodeConfigDataSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
  path: z.string().nullable(),
  updatedAt: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2RawOpencodeConfigData" });

export const workspaceConfigResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceConfigResponse",
  workspaceConfigSnapshotSchema,
);

export const rawOpencodeConfigResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2RawOpencodeConfigResponse",
  rawOpencodeConfigDataSchema,
);

export const rawOpencodeConfigParamsSchema = workspaceIdParamsSchema.meta({ ref: "OpenrindDesktopServerV2RawOpencodeConfigParams" });
