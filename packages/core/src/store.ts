/** Persistence port. `@gcm/storage` implements it with SQLite; tests may use the same implementation in a temp dir. */
import type {
  BotProfile,
  CheckpointRecord,
  HandoffRecord,
  ImportRecord,
  StoredMessage,
  UsageRecord,
} from './schemas';

export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArchiveHit {
  messageId: string;
  importId: string;
  seq: number;
  role: string;
  timestamp: string | null;
  snippet: string;
}

export interface OperationRecord {
  id: string;
  at: string;
  op: string;
  channel: string;
  botId: string | null;
  durationMs: number;
  ok: boolean;
  /** Short non-content detail (error code, counts). Never conversation content. */
  detail: string;
  /** Tokens consumed by a local model during this operation (0 for deterministic work). */
  modelTokens: number;
  /** Estimated tokens GCM returned into a client's context (MCP responses). */
  responseTokens: number;
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  bots: '*' | string[];
  canWrite: boolean;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface StoreInfo {
  path: string;
  schemaVersion: number;
  sizeBytes: number;
  ftsEnabled: boolean;
}

export interface DeletionCounts {
  bots: number;
  imports: number;
  messages: number;
  checkpoints: number;
  handoffs: number;
  usage: number;
}

export interface Store {
  transaction<T>(fn: () => T): T;

  listBots(): BotProfile[];
  getBot(id: string): BotProfile | null;
  saveBot(bot: BotProfile): void;

  insertImport(record: ImportRecord, messages: StoredMessage[]): void;
  getImport(id: string): ImportRecord | null;
  listImports(botId: string, page?: Page): Paged<ImportRecord>;
  getMessages(importIds: string[]): StoredMessage[];
  /** Content-hash → occurrence count of stored messages for a bot/session (for overlap detection). */
  messageHashCounts(botId: string, sessionRef: string | null): Map<string, number>;
  archiveStats(botId: string): { imports: number; messages: number; chars: number; tokens: number };
  searchArchive(botId: string, query: string, page: Page): Paged<ArchiveHit>;

  insertCheckpoint(ck: CheckpointRecord): void;
  getCheckpoint(id: string): CheckpointRecord | null;
  listCheckpoints(botId: string, page: Page): Paged<CheckpointRecord>;
  headCheckpoint(botId: string): CheckpointRecord | null;
  coveredImportIds(botId: string): Set<string>;
  setCheckpointReview(
    id: string,
    status: 'unreviewed' | 'reviewed',
    at: string | null,
    note: string | null,
  ): void;

  insertHandoff(h: HandoffRecord): void;
  updateHandoff(h: HandoffRecord): void;
  getHandoff(id: string): HandoffRecord | null;
  listHandoffs(botId: string | null, page: Page): Paged<HandoffRecord>;

  insertUsage(r: UsageRecord): void;
  listUsage(botId: string): UsageRecord[];

  getSettings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;

  cacheGet(key: string): string | null;
  cachePut(key: string, value: string): void;

  logOperation(op: OperationRecord): void;
  listOperations(opts: { botId?: string; limit: number }): OperationRecord[];
  operationTotals(botId?: string): {
    count: number;
    durationMs: number;
    modelTokens: number;
    responseTokens: number;
  };

  insertApiToken(t: ApiTokenRecord): void;
  listApiTokens(): ApiTokenRecord[];
  findApiTokenByHash(hash: string): ApiTokenRecord | null;
  touchApiToken(id: string, at: string): void;
  revokeApiToken(id: string, at: string): boolean;

  deleteBotData(botId: string): DeletionCounts;
  deleteAllData(): DeletionCounts;
  backup(destPath: string): Promise<void>;
  integrityCheck(): string[];
  info(): StoreInfo;
  close(): void;
}
