/**
 * Versioned data schemas for everything GCM stores or exchanges.
 * Zod schemas validate every boundary (CLI input, MCP input, dashboard API, external checkpoint files);
 * TypeScript types are inferred from them so there is one source of truth.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
/** Bumped whenever the deterministic engine's output could change for the same input (cache key). */
export const ENGINE_VERSION = 'det-1.0.0';
export const APP_VERSION = '0.1.0';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const BotIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    'Bot IDs use lowercase letters, digits, "-" or "_" (max 64 chars), e.g. "sales" or "chief-of-staff".',
  );

export const RoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'unknown']);
export type Role = z.infer<typeof RoleSchema>;

/**
 * How much of the real conversation the imported material covers.
 * `complete` is only ever set when the user explicitly asserts it; GCM cannot see Grok Bot's transcript.
 */
export const CompletenessSchema = z.enum(['complete', 'partial', 'unknown']);
export type Completeness = z.infer<typeof CompletenessSchema>;

export const ProfileNameSchema = z.enum(['compact', 'balanced', 'detailed']);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const SourceFormatSchema = z.enum(['auto', 'text', 'markdown', 'json', 'jsonl']);
export type SourceFormat = z.infer<typeof SourceFormatSchema>;

const line = (max = 2000) => z.string().trim().min(1).max(max);
const lines = (maxItems = 200, maxLen = 2000) => z.array(line(maxLen)).max(maxItems);

// ---------------------------------------------------------------------------------------------
// Bot profiles (Identity)
// ---------------------------------------------------------------------------------------------

export const BotPolicySchema = z.object({
  /** Default checkpoint/handoff profile for this bot. */
  profile: ProfileNameSchema.default('balanced'),
  /** Overrides the profile's handoff token budget. */
  handoffBudgetTokens: z.number().int().min(200).max(100_000).nullable().default(null),
  /** Warn when the estimated size of imported, not-yet-checkpointed material exceeds this. */
  warnThresholdTokens: z.number().int().min(1000).max(5_000_000).default(100_000),
  /** Other bot IDs explicitly allowed to read this bot's GCM data (default: none). */
  shareWith: z.array(BotIdSchema).max(50).default([]),
  /** When false the bot is hidden from every MCP client. */
  mcpExposed: z.boolean().default(true),
});
export type BotPolicy = z.infer<typeof BotPolicySchema>;
export const BotPolicyPatchSchema = z
  .object({
    profile: ProfileNameSchema,
    handoffBudgetTokens: z.number().int().min(200).max(100_000).nullable(),
    warnThresholdTokens: z.number().int().min(1000).max(5_000_000),
    shareWith: z.array(BotIdSchema).max(50),
    mcpExposed: z.boolean(),
  })
  .partial()
  .strict();

const identityFields = {
  name: line(120),
  role: z.string().trim().max(500),
  responsibilities: lines(),
  instructions: lines(),
  preferences: lines(),
  securityBoundaries: lines(),
  longTermDecisions: lines(),
  skills: lines(200, 300),
  plugins: lines(200, 300),
  routines: lines(200, 1000),
  projects: lines(200, 500),
  memoryReferences: lines(),
  notes: z.string().max(20_000),
};

export const BotProfileSchema = z.object({
  id: BotIdSchema,
  ...identityFields,
  /** Identity in GCM is always user-provided; GCM never reads Grok Bot's private settings. */
  identitySource: z.literal('user_provided'),
  policy: BotPolicySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotProfile = z.infer<typeof BotProfileSchema>;

export const BotPatchSchema = z
  .object({
    id: BotIdSchema,
    name: identityFields.name.optional(),
    role: identityFields.role.optional(),
    responsibilities: identityFields.responsibilities.optional(),
    instructions: identityFields.instructions.optional(),
    preferences: identityFields.preferences.optional(),
    securityBoundaries: identityFields.securityBoundaries.optional(),
    longTermDecisions: identityFields.longTermDecisions.optional(),
    skills: identityFields.skills.optional(),
    plugins: identityFields.plugins.optional(),
    routines: identityFields.routines.optional(),
    projects: identityFields.projects.optional(),
    memoryReferences: identityFields.memoryReferences.optional(),
    notes: identityFields.notes.optional(),
    policy: BotPolicyPatchSchema.optional(),
  })
  .strict();
export type BotPatch = z.infer<typeof BotPatchSchema>;

// ---------------------------------------------------------------------------------------------
// Archive: imports and messages
// ---------------------------------------------------------------------------------------------

export interface ParsedMessage {
  role: Role;
  author?: string;
  timestamp?: string;
  content: string;
}

export interface StoredMessage extends ParsedMessage {
  id: string;
  importId: string;
  botId: string;
  seq: number;
  contentHash: string;
}

/** Hard ceiling for one import (characters). Larger exports should be split. */
export const MAX_IMPORT_CHARS = 5_000_000;

export const ImportInputSchema = z
  .object({
    botId: BotIdSchema,
    text: z.string().min(1).max(MAX_IMPORT_CHARS),
    format: SourceFormatSchema.default('auto'),
    sessionRef: z.string().trim().min(1).max(200).nullable().default(null),
    sourceName: z.string().trim().min(1).max(300).nullable().default(null),
    completeness: CompletenessSchema.default('unknown'),
    completenessNote: z.string().max(1000).nullable().default(null),
    /** Extra speaker names to treat as the bot (the bot profile's name and id are always included). */
    assistantNames: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    /** Speaker names to treat as the human user. */
    userNames: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  })
  .strict();
export type ImportInput = z.input<typeof ImportInputSchema>;

export interface ImportRecord {
  id: string;
  botId: string;
  sessionRef: string | null;
  sourceFormat: Exclude<SourceFormat, 'auto'>;
  sourceName: string | null;
  importedAt: string;
  completeness: Completeness;
  completenessNote: string | null;
  messageCount: number;
  charCount: number;
  tokenEstimate: number;
  /** sha256 over the canonical (seq, role, content) list of this import's stored messages. */
  contentHash: string;
  duplicatesSkipped: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Context items produced by the compaction engine
// ---------------------------------------------------------------------------------------------

export const CategorySchema = z.enum([
  'permanent',
  'active_work',
  'decision',
  'open_question',
  'temporary',
  'obsolete',
  'historical',
]);
export type Category = z.infer<typeof CategorySchema>;

export const ItemKindSchema = z.enum([
  'fact',
  'preference',
  'policy',
  'constraint',
  'objective',
  'task',
  'completed',
  'decision',
  'question',
  'blocker',
  'chatter',
  'superseded',
  'evidence',
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const FlagSchema = z.enum([
  'negative_instruction',
  'security',
  'deadline',
  'conflict',
  'secret_redacted',
  'injection_suspect',
  'supersedes',
  'approved_proposal',
  'truncated',
  'carried_forward',
  'user_stated',
]);
export type Flag = z.infer<typeof FlagSchema>;

export const SourceRefSchema = z.object({
  importId: z.string(),
  seq: z.number().int(),
  role: RoleSchema,
  timestamp: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ContextItemSchema = z.object({
  id: z.string(),
  category: CategorySchema,
  kind: ItemKindSchema,
  /** Verbatim source wording (secrets redacted, possibly truncated with a `truncated` flag). */
  text: z.string(),
  flags: z.array(FlagSchema),
  identifiers: z.array(z.string()),
  deadline: z.string().optional(),
  sourceRefs: z.array(SourceRefSchema),
  confidence: z.number().min(0).max(1),
  /** Why the engine classified it this way (signals matched). */
  reason: z.string(),
  /** Protected items are never dropped to meet a budget. */
  protected: z.boolean(),
  supersededBy: z.string().optional(),
  /** Global order of first appearance; carried-forward items use negative values. */
  order: z.number(),
});
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const ConflictSchema = z.object({
  id: z.string(),
  itemIds: z.tuple([z.string(), z.string()]),
  texts: z.tuple([z.string(), z.string()]),
  reason: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const ResourceSchema = z.object({
  value: z.string(),
  type: z.enum([
    'file',
    'url',
    'ticket',
    'email',
    'identifier',
    'env',
    'version',
    'amount',
    'date',
  ]),
  sourceRefs: z.array(SourceRefSchema),
});
export type Resource = z.infer<typeof ResourceSchema>;

// ---------------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------------

export const ObjectiveSchema = z.object({
  text: z.string(),
  basis: z.enum(['explicit', 'inferred_latest_request', 'carried_forward', 'user_supplied']),
  sourceRefs: z.array(SourceRefSchema),
});

export const CheckpointContentSchema = z.object({
  identity: z.object({
    botId: BotIdSchema,
    name: z.string(),
    role: z.string(),
    /** Hash of the bot profile at checkpoint time (detects later identity edits). */
    profileHash: z.string(),
    source: z.literal('user_provided'),
    /** Snapshot of the profile's security boundaries and operating instructions at checkpoint time. */
    standingRules: z.array(z.string()).default([]),
  }),
  workstream: z.string().nullable(),
  objective: ObjectiveSchema.nullable(),
  constraints: z.array(ContextItemSchema),
  decisions: z.array(ContextItemSchema),
  pendingTasks: z.array(ContextItemSchema),
  openQuestions: z.array(ContextItemSchema),
  progress: z.array(ContextItemSchema),
  knowledge: z.array(ContextItemSchema),
  resources: z.array(ResourceSchema),
  conflicts: z.array(ConflictSchema),
  uncertainties: z.array(z.string()),
  recommendedNextAction: z
    .object({ text: z.string(), basis: z.string(), sourceRefs: z.array(SourceRefSchema) })
    .nullable(),
  /** Optional local-model narrative (validated against the source; never authoritative). */
  narrative: z.string().nullable(),
  excluded: z.object({
    temporary: z.number().int(),
    obsolete: z.number().int(),
    historical: z.number().int(),
    quarantined: z.number().int(),
    overBudget: z.number().int(),
    overBudgetItems: z.array(ContextItemSchema),
  }),
  stats: z.object({
    sourceMessages: z.number().int(),
    sourceChars: z.number().int(),
    sourceTokensEstimate: z.number().int(),
    unitsAnalyzed: z.number().int(),
    duplicatesMerged: z.number().int(),
    supersessions: z.number().int(),
  }),
});
export type CheckpointContent = z.infer<typeof CheckpointContentSchema>;

export const CheckpointSourceSchema = z.object({
  importIds: z.array(z.string()),
  completeness: CompletenessSchema,
  messageCount: z.number().int(),
  provider: z.string(),
  profile: ProfileNameSchema,
  engineVersion: z.string(),
  basedOnCheckpointId: z.string().nullable(),
});

export const TokenEstimateSchema = z.object({
  tokens: z.number().int(),
  method: z.string(),
  /** Always "estimated": GCM never claims a locally computed number is a provider measurement. */
  kind: z.literal('estimated'),
});
export type TokenEstimate = z.infer<typeof TokenEstimateSchema>;

export const CheckpointRecordSchema = z.object({
  id: z.string(),
  botId: BotIdSchema,
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  restoredFromId: z.string().nullable(),
  schemaVersion: z.number().int(),
  createdAt: z.string(),
  sessionRef: z.string().nullable(),
  source: CheckpointSourceSchema,
  content: CheckpointContentSchema,
  contentHash: z.string(),
  tokenEstimate: TokenEstimateSchema,
  reviewStatus: z.enum(['unreviewed', 'reviewed']),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

/** File format written by `gcm checkpoint export --format json`. */
export const CheckpointExportSchema = z.object({
  format: z.literal('gcm-checkpoint'),
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  appVersion: z.string(),
  checkpoint: CheckpointRecordSchema,
});
export type CheckpointExport = z.infer<typeof CheckpointExportSchema>;

// ---------------------------------------------------------------------------------------------
// Handoffs and the guided reset workflow
// ---------------------------------------------------------------------------------------------

export const HandoffStateSchema = z.enum([
  'CHECKPOINT_READY',
  'ARCHIVE_VERIFIED',
  'HANDOFF_READY',
  'USER_ACTION_REQUIRED',
  'EXTERNAL_RESET_UNVERIFIED',
  'CONTINUATION_VERIFIED',
  'FAILED_RECOVERABLE',
]);
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const PlatformActionSchema = z.enum([
  /** Non-destructive: start a new group chat that includes this bot (old chat stays as history). */
  'new_group_chat',
  /** Destructive to the platform transcript, only where the user's build shows "Reset chat". */
  'reset_chat',
  /** Paste into the existing conversation. Refocuses the bot; does not shrink platform context. */
  'continue_in_place',
]);
export type PlatformAction = z.infer<typeof PlatformActionSchema>;

export interface HandoffEvent {
  state: HandoffState;
  at: string;
  note: string;
}

export interface HandoffRecord {
  id: string;
  botId: string;
  checkpointId: string;
  createdAt: string;
  profile: ProfileName;
  budgetTokens: number;
  text: string;
  tokenEstimate: TokenEstimate;
  verificationCode: string;
  state: HandoffState;
  platformAction: PlatformAction | null;
  events: HandoffEvent[];
}

// ---------------------------------------------------------------------------------------------
// Usage measurements supplied by the user (never fabricated)
// ---------------------------------------------------------------------------------------------

export const UsageKindSchema = z.enum(['provider_measured', 'billing']);
export const UsageInputSchema = z
  .object({
    botId: BotIdSchema,
    kind: UsageKindSchema,
    /** Free label, e.g. "before_handoff", "after_handoff", "week-41". */
    label: z.string().trim().min(1).max(100),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    /** Billing/quota units as reported by the platform (e.g. "% of weekly allowance"). */
    amount: z.number().nonnegative().nullable().default(null),
    unit: z.string().trim().max(50).nullable().default(null),
    source: z.string().trim().max(300).default('user-supplied'),
    measuredAt: z.string().max(40).nullable().default(null),
    note: z.string().max(1000).nullable().default(null),
  })
  .strict();
export type UsageInput = z.input<typeof UsageInputSchema>;
export type UsageRecord = z.infer<typeof UsageInputSchema> & { id: string; recordedAt: string };

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const SettingsSchema = z.object({
  summarizer: z.enum(['deterministic', 'ollama']).default('deterministic'),
  ollamaUrl: z.string().url().default('http://127.0.0.1:11434'),
  ollamaModel: z.string().max(200).nullable().default(null),
  ollamaTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  tokenMethod: z.enum(['heuristic', 'o200k']).default('heuristic'),
  defaultProfile: ProfileNameSchema.default('balanced'),
  budgets: z
    .object({
      compact: z.number().int().min(200).max(100_000).default(900),
      balanced: z.number().int().min(200).max(100_000).default(2000),
      detailed: z.number().int().min(200).max(100_000).default(5000),
    })
    .prefault({}),
  mcpMaxResponseTokens: z.number().int().min(500).max(50_000).default(4000),
  /** GCM never sends telemetry. This is a read-only fact surfaced in the UI, not a toggle. */
  telemetry: z.literal(false).default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Access scope applied to every service call (local CLI = full; MCP tokens = restricted). */
export interface AccessContext {
  /** `'*'` = every bot; otherwise the explicit list of bot IDs this caller may touch. */
  bots: '*' | string[];
  canWrite: boolean;
  /** Bot the caller acts for, when known (enables `shareWith` grants). */
  actorBotId?: string;
  channel: 'cli' | 'dashboard' | 'mcp';
}

export const LOCAL_ACCESS: AccessContext = { bots: '*', canWrite: true, channel: 'cli' };
