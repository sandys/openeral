import { z } from "zod";
import { identifierSchema, isoTimestampSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const managedKindSchema = z.enum(["mcps", "plugins", "providerConfigs", "skills"]);

export const managedItemSchema = z.object({
  auth: jsonObjectSchema.nullable(),
  cloudItemId: z.string().nullable(),
  config: jsonObjectSchema,
  createdAt: isoTimestampSchema,
  displayName: z.string(),
  id: identifierSchema,
  key: z.string().nullable(),
  metadata: jsonObjectSchema.nullable(),
  source: z.enum(["cloud_synced", "discovered", "imported", "openrind_desktop_managed"]),
  updatedAt: isoTimestampSchema,
  workspaceIds: z.array(identifierSchema),
}).meta({ ref: "OpenrindDesktopServerV2ManagedItem" });

export const managedItemWriteSchema = z.object({
  auth: jsonObjectSchema.nullable().optional(),
  cloudItemId: z.string().nullable().optional(),
  config: jsonObjectSchema.optional(),
  displayName: z.string(),
  key: z.string().nullable().optional(),
  metadata: jsonObjectSchema.nullable().optional(),
  source: z.enum(["cloud_synced", "discovered", "imported", "openrind_desktop_managed"]).optional(),
  workspaceIds: z.array(identifierSchema).optional(),
}).meta({ ref: "OpenrindDesktopServerV2ManagedItemWrite" });

export const managedAssignmentWriteSchema = z.object({
  workspaceIds: z.array(identifierSchema),
}).meta({ ref: "OpenrindDesktopServerV2ManagedAssignmentWrite" });

export const managedItemListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2ManagedItemListResponse",
  z.object({ items: z.array(managedItemSchema) }),
);
export const managedItemResponseSchema = successResponseSchema("OpenrindDesktopServerV2ManagedItemResponse", managedItemSchema);
export const managedDeleteResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2ManagedDeleteResponse",
  z.object({ deleted: z.boolean(), id: identifierSchema }),
);

export const workspaceMcpItemSchema = z.object({
  config: jsonObjectSchema,
  disabledByTools: z.boolean().optional(),
  name: z.string(),
  source: z.enum(["config.global", "config.project", "config.remote"]),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceMcpItem" });
export const workspaceMcpListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceMcpListResponse",
  z.object({ items: z.array(workspaceMcpItemSchema) }),
);
export const workspaceMcpWriteSchema = z.object({
  config: jsonObjectSchema,
  name: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceMcpWrite" });

export const workspacePluginItemSchema = z.object({
  path: z.string().optional(),
  scope: z.enum(["global", "project"]),
  source: z.enum(["config", "dir.project", "dir.global"]),
  spec: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspacePluginItem" });
export const workspacePluginListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspacePluginListResponse",
  z.object({ items: z.array(workspacePluginItemSchema), loadOrder: z.array(z.string()) }),
);
export const workspacePluginWriteSchema = z.object({ spec: z.string() }).meta({ ref: "OpenrindDesktopServerV2WorkspacePluginWrite" });

export const workspaceSkillItemSchema = z.object({
  description: z.string(),
  name: z.string(),
  path: z.string(),
  scope: z.enum(["global", "project"]),
  trigger: z.string().optional(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceSkillItem" });
export const workspaceSkillContentSchema = z.object({
  content: z.string(),
  item: workspaceSkillItemSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceSkillContent" });
export const workspaceSkillListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceSkillListResponse",
  z.object({ items: z.array(workspaceSkillItemSchema) }),
);
export const workspaceSkillResponseSchema = successResponseSchema("OpenrindDesktopServerV2WorkspaceSkillResponse", workspaceSkillContentSchema);
export const workspaceSkillWriteSchema = z.object({
  content: z.string(),
  description: z.string().optional(),
  name: z.string(),
  trigger: z.string().optional(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceSkillWrite" });
export const workspaceSkillDeleteResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2WorkspaceSkillDeleteResponse",
  z.object({ path: z.string() }),
);

export const hubRepoSchema = z.object({
  owner: z.string().optional(),
  ref: z.string().optional(),
  repo: z.string().optional(),
}).meta({ ref: "OpenrindDesktopServerV2HubRepo" });
export const hubSkillItemSchema = z.object({
  description: z.string(),
  name: z.string(),
  source: z.object({ owner: z.string(), path: z.string(), ref: z.string(), repo: z.string() }),
  trigger: z.string().optional(),
}).meta({ ref: "OpenrindDesktopServerV2HubSkillItem" });
export const hubSkillListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2HubSkillListResponse",
  z.object({ items: z.array(hubSkillItemSchema) }),
);
export const hubSkillInstallWriteSchema = z.object({
  overwrite: z.boolean().optional(),
  repo: hubRepoSchema.optional(),
}).meta({ ref: "OpenrindDesktopServerV2HubSkillInstallWrite" });
export const hubSkillInstallResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2HubSkillInstallResponse",
  z.object({
    action: z.enum(["added", "updated"]),
    name: z.string(),
    path: z.string(),
    skipped: z.number().int().nonnegative(),
    written: z.number().int().nonnegative(),
  }),
);

export const cloudSigninSchema = z.object({
  auth: jsonObjectSchema.nullable(),
  cloudBaseUrl: z.string(),
  createdAt: isoTimestampSchema,
  id: identifierSchema,
  lastValidatedAt: isoTimestampSchema.nullable(),
  metadata: jsonObjectSchema.nullable(),
  orgId: z.string().nullable(),
  serverId: identifierSchema,
  updatedAt: isoTimestampSchema,
  userId: z.string().nullable(),
}).meta({ ref: "OpenrindDesktopServerV2CloudSignin" });
export const cloudSigninWriteSchema = z.object({
  auth: jsonObjectSchema.nullable().optional(),
  cloudBaseUrl: z.string(),
  metadata: jsonObjectSchema.nullable().optional(),
  orgId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
}).meta({ ref: "OpenrindDesktopServerV2CloudSigninWrite" });
export const cloudSigninResponseSchema = successResponseSchema("OpenrindDesktopServerV2CloudSigninResponse", cloudSigninSchema.nullable());
export const cloudSigninValidationResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2CloudSigninValidationResponse",
  z.object({ lastValidatedAt: isoTimestampSchema.nullable(), ok: z.boolean(), record: cloudSigninSchema }),
);

export const workspaceShareSchema = z.object({
  accessKey: z.string().nullable(),
  audit: jsonObjectSchema.nullable(),
  createdAt: isoTimestampSchema,
  id: identifierSchema,
  lastUsedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
  status: z.enum(["active", "disabled", "revoked"]),
  updatedAt: isoTimestampSchema,
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceShare" });
export const workspaceShareResponseSchema = successResponseSchema("OpenrindDesktopServerV2WorkspaceShareResponse", workspaceShareSchema.nullable());

export const workspaceExportWarningSchema = z.object({
  detail: z.string(),
  id: z.string(),
  label: z.string(),
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceExportWarning" });
export const workspaceExportDataSchema = z.object({
  commands: z.array(z.object({ description: z.string().optional(), name: z.string(), template: z.string() })),
  exportedAt: z.number().int().nonnegative(),
  files: z.array(z.object({ content: z.string(), path: z.string() })).optional(),
  openrindDesktop: jsonObjectSchema,
  opencode: jsonObjectSchema,
  skills: z.array(z.object({ content: z.string(), description: z.string().optional(), name: z.string(), trigger: z.string().optional() })),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenrindDesktopServerV2WorkspaceExportData" });
export const workspaceExportResponseSchema = successResponseSchema("OpenrindDesktopServerV2WorkspaceExportResponse", workspaceExportDataSchema);
export const workspaceImportWriteSchema = z.record(z.string(), z.unknown()).meta({ ref: "OpenrindDesktopServerV2WorkspaceImportWrite" });
export const workspaceImportResponseSchema = successResponseSchema("OpenrindDesktopServerV2WorkspaceImportResponse", z.object({ ok: z.boolean() }));

export const sharedBundlePublishWriteSchema = z.object({
  bundleType: z.string(),
  name: z.string().optional(),
  payload: z.unknown(),
  timeoutMs: z.number().int().positive().optional(),
}).meta({ ref: "OpenrindDesktopServerV2SharedBundlePublishWrite" });
export const sharedBundleFetchWriteSchema = z.object({
  bundleUrl: z.string(),
  timeoutMs: z.number().int().positive().optional(),
}).meta({ ref: "OpenrindDesktopServerV2SharedBundleFetchWrite" });
export const sharedBundlePublishResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SharedBundlePublishResponse",
  z.object({ url: z.string() }),
);
export const sharedBundleFetchResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2SharedBundleFetchResponse",
  z.record(z.string(), z.unknown()),
);

export const routerIdentityItemSchema = z.object({
  access: z.enum(["private", "public"]).optional(),
  enabled: z.boolean(),
  id: z.string(),
  pairingRequired: z.boolean().optional(),
  running: z.boolean(),
}).meta({ ref: "OpenrindDesktopServerV2RouterIdentityItem" });
export const routerHealthSnapshotSchema = z.object({
  config: z.object({ groupsEnabled: z.boolean() }),
  channels: z.object({ slack: z.boolean(), telegram: z.boolean(), whatsapp: z.boolean() }),
  ok: z.boolean(),
  opencode: z.object({ healthy: z.boolean(), url: z.string(), version: z.string().optional() }),
}).meta({ ref: "OpenrindDesktopServerV2RouterHealthSnapshot" });
export const routerIdentityListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2RouterIdentityListResponse",
  z.object({ items: z.array(routerIdentityItemSchema), ok: z.boolean() }),
);
export const routerTelegramInfoResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2RouterTelegramInfoResponse",
  z.object({
    bot: z.object({ id: z.number().int(), name: z.string().optional(), username: z.string().optional() }).nullable(),
    configured: z.boolean(),
    enabled: z.boolean(),
    ok: z.boolean(),
  }),
);
export const routerHealthResponseSchemaCompat = successResponseSchema("OpenrindDesktopServerV2RouterHealthCompatResponse", routerHealthSnapshotSchema);
export const routerTelegramWriteSchema = z.object({ access: z.enum(["private", "public"]).optional(), enabled: z.boolean().optional(), id: z.string().optional(), token: z.string() }).meta({ ref: "OpenrindDesktopServerV2RouterTelegramWrite" });
export const routerSlackWriteSchema = z.object({ appToken: z.string(), botToken: z.string(), enabled: z.boolean().optional(), id: z.string().optional() }).meta({ ref: "OpenrindDesktopServerV2RouterSlackWrite" });
export const routerBindingWriteSchema = z.object({ channel: z.enum(["slack", "telegram"]), directory: z.string().optional(), identityId: z.string().optional(), peerId: z.string() }).meta({ ref: "OpenrindDesktopServerV2RouterBindingWrite" });
export const routerBindingListResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2RouterBindingListResponse",
  z.object({
    items: z.array(z.object({ channel: z.string(), directory: z.string(), identityId: z.string(), peerId: z.string(), updatedAt: z.number().int().optional() })),
    ok: z.boolean(),
  }),
);
export const routerSendWriteSchema = z.object({ autoBind: z.boolean().optional(), channel: z.enum(["slack", "telegram"]), directory: z.string().optional(), identityId: z.string().optional(), peerId: z.string().optional(), text: z.string() }).meta({ ref: "OpenrindDesktopServerV2RouterSendWrite" });
export const routerMutationResponseSchema = successResponseSchema(
  "OpenrindDesktopServerV2RouterMutationResponse",
  z.record(z.string(), z.unknown()),
);

export const managedItemIdParamsSchema = z.object({ itemId: identifierSchema }).meta({ ref: "OpenrindDesktopServerV2ManagedItemIdParams" });
export const workspaceNamedItemParamsSchema = workspaceIdParamsSchema.extend({ name: z.string() }).meta({ ref: "OpenrindDesktopServerV2WorkspaceNamedItemParams" });
export const workspaceIdentityParamsSchema = workspaceIdParamsSchema.extend({ identityId: identifierSchema }).meta({ ref: "OpenrindDesktopServerV2WorkspaceIdentityParams" });
