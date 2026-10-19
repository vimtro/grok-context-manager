/**
 * SQLite implementation of the GCM Store.
 *
 * Durability: WAL journal + synchronous=FULL, every multi-row write in a transaction, checkpoints are
 * immutable at the database level (trigger), versions are allocated with a compare-and-insert so two
 * concurrent writers cannot fork a bot's history, and the database file is copied to backups/ before any
 * schema migration.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  GcmError,
  type ApiTokenRecord,
  type ArchiveHit,
  type BotProfile,
  type CheckpointRecord,
  type DeletionCounts,
  type HandoffRecord,
  type ImportRecord,
  type OperationRecord,
  type Page,
  type Paged,
  type Store,
  type StoreInfo,
  type StoredMessage,
  type UsageRecord,
} from '@gcm/core';
import { DB_FILENAME, ensureDataDir, restrictPermissions } from './paths';

type Row = Record<string, unknown>;

interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE imports (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        char_count INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX imports_bot ON imports(bot_id, imported_at);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        author TEXT,
        timestamp TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(import_id, seq)
      );
      CREATE INDEX messages_dedupe ON messages(bot_id, session_key, content_hash);
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages BEGIN
        SELECT RAISE(ABORT, 'archived messages are immutable');
      END;
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        review_status TEXT NOT NULL,
        reviewed_at TEXT,
        review_note TEXT,
        data TEXT NOT NULL,
        UNIQUE(bot_id, version)
      );
      CREATE TRIGGER checkpoints_immutable BEFORE UPDATE OF id, bot_id, version, parent_id, created_at, content_hash, data ON checkpoints BEGIN
        SELECT RAISE(ABORT, 'checkpoints are immutable; create a new version instead');
      END;
      CREATE TABLE checkpoint_imports (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        import_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, import_id)
      );
      CREATE INDEX checkpoint_imports_bot ON checkpoint_imports(bot_id);
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX handoffs_bot ON handoffs(bot_id, created_at);
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        op TEXT NOT NULL,
        channel TEXT NOT NULL,
        bot_id TEXT,
        duration_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT NOT NULL,
        model_tokens INTEGER NOT NULL,
        response_tokens INTEGER NOT NULL
      );
      CREATE INDEX operations_bot ON operations(bot_id, at);
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        bots TEXT NOT NULL,
        can_write INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const CACHE_LIMIT = 500;
const OPERATIONS_LIMIT = 20_000;

export interface OpenOptions {
  /** Data directory; the database lives at <dir>/gcm.sqlite. */
  dataDir: string;
  readonly?: boolean;
}

export class SqliteStore implements Store {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly dataDir: string;

  private constructor(dataDir: string, db: Database.Database, dbPath: string) {
    this.dataDir = dataDir;
    this.db = db;
    this.dbPath = dbPath;
  }

  static open(opts: OpenOptions): SqliteStore {
    const dir = ensureDataDir(opts.dataDir);
    const dbPath = path.join(dir, DB_FILENAME);
    const existed = existsSync(dbPath) && statSync(dbPath).size > 0;
    const db = new Database(dbPath, {
      readonly: Boolean(opts.readonly),
      fileMustExist: Boolean(opts.readonly),
    });
    restrictPermissions(dbPath, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('secure_delete = ON');
    const store = new SqliteStore(dir, db, dbPath);
    if (!opts.readonly) {
      try {
        store.migrate(existed);
      } catch (e) {
        db.close(); // never leave a locked handle behind (Windows cannot delete open files)
        throw e;
      }
    }
    return store;
  }

  private schemaVersion(): number {
    const v = this.db.pragma('user_version', { simple: true });
    return typeof v === 'number' ? v : Number(v);
  }

  private migrate(existed: boolean): void {
    const current = this.schemaVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new GcmError(
        'INTEGRITY',
        `This database uses schema v${current}, newer than this GCM build supports (v${LATEST_SCHEMA_VERSION}).`,
        'Upgrade GCM; your data was not modified.',
      );
    }
    if (current === LATEST_SCHEMA_VERSION) return;
    if (existed && current > 0) {
      // Recoverable migrations: snapshot the whole file first.
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(
        this.dbPath,
        path.join(this.dataDir, 'backups', `pre-migrate-v${current}-${stamp}.sqlite`),
      );
    }
    for (const m of MIGRATIONS.filter((x) => x.version > current)) {
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.pragma(`user_version = ${m.version}`);
      })();
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------------------------------------- bots

  listBots(): BotProfile[] {
    return this.db
      .prepare('SELECT data FROM bots ORDER BY id')
      .all()
      .map((r) => parse<BotProfile>((r as Row).data));
  }

  getBot(id: string): BotProfile | null {
    const r = this.db.prepare('SELECT data FROM bots WHERE id = ?').get(id) as Row | undefined;
    return r ? parse<BotProfile>(r.data) : null;
  }

  saveBot(bot: BotProfile): void {
    this.db
      .prepare(
        `INSERT INTO bots (id, data, created_at, updated_at) VALUES (@id, @data, @created, @updated)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run({
        id: bot.id,
        data: JSON.stringify(bot),
        created: bot.createdAt,
        updated: bot.updatedAt,
      });
  }

  // ------------------------------------------------------------------------------------------- archive

  insertImport(record: ImportRecord, messages: StoredMessage[]): void {
    const sessionKey = record.sessionRef ?? '';
    const insImport = this.db.prepare(
      `INSERT INTO imports (id, bot_id, session_key, imported_at, message_count, char_count, token_estimate, content_hash, data)
       VALUES (@id, @botId, @sessionKey, @importedAt, @messageCount, @charCount, @tokenEstimate, @contentHash, @data)`,
    );
    const insMsg = this.db.prepare(
      `INSERT INTO messages (id, import_id, bot_id, session_key, seq, role, author, timestamp, content, content_hash)
       VALUES (@id, @importId, @botId, @sessionKey, @seq, @role, @author, @timestamp, @content, @contentHash)`,
    );
    this.db.transaction(() => {
      insImport.run({ ...record, sessionKey, data: JSON.stringify(record) });
      for (const m of messages) {
        if (m.importId !== record.id || m.botId !== record.botId)
          throw new GcmError('INTERNAL', 'Message/import mismatch.');
        insMsg.run({
          id: m.id,
          importId: m.importId,
          botId: m.botId,
          sessionKey,
          seq: m.seq,
          role: m.role,
          author: m.author ?? null,
          timestamp: m.timestamp ?? null,
          content: m.content,
          contentHash: m.contentHash,
        });
      }
    })();
  }

  getImport(id: string): ImportRecord | null {
    const r = this.db.prepare('SELECT data FROM imports WHERE id = ?').get(id) as Row | undefined;
    return r ? parse<ImportRecord>(r.data) : null;
  }

  listImports(botId: string, page: Page = { limit: 50, offset: 0 }): Paged<ImportRecord> {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM imports WHERE bot_id = ?').get(botId) as Row
    ).n as number;
    const items = this.db
      .prepare(
        'SELECT data FROM imports WHERE bot_id = ? ORDER BY imported_at, id LIMIT ? OFFSET ?',
      )
      .all(botId, page.limit, page.offset)
      .map((r) => parse<ImportRecord>((r as Row).data));
    return { items, total, ...page };
  }

  getMessages(importIds: string[]): StoredMessage[] {
    if (importIds.length === 0) return [];
    const out: StoredMessage[] = [];
    const stmt = this.db.prepare(
      `SELECT m.* FROM messages m JOIN imports i ON i.id = m.import_id WHERE m.import_id = ? ORDER BY m.seq`,
    );
    // Preserve chronological import order.
    const ordered = importIds
      .map((id) => ({
        id,
        at:
          ((
            this.db.prepare('SELECT imported_at FROM imports WHERE id = ?').get(id) as
              Row | undefined
          )?.imported_at as string) ?? '',
      }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const { id } of ordered) {
      for (const r of stmt.all(id) as Row[]) out.push(toMessage(r));
    }
    return out;
  }

  messageHashCounts(botId: string, sessionRef: string | null): Map<string, number> {
    const rows = this.db
      .prepare(
        'SELECT content_hash, COUNT(*) AS n FROM messages WHERE bot_id = ? AND session_key = ? GROUP BY content_hash',
      )
      .all(botId, sessionRef ?? '') as Row[];
    return new Map(rows.map((r) => [r.content_hash as string, Number(r.n)]));
  }

  archiveStats(botId: string): {
    imports: number;
    messages: number;
    chars: number;
    tokens: number;
  } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS imports, COALESCE(SUM(message_count),0) AS messages, COALESCE(SUM(char_count),0) AS chars, COALESCE(SUM(token_estimate),0) AS tokens FROM imports WHERE bot_id = ?',
      )
      .get(botId) as Row;
    return {
      imports: Number(r.imports),
      messages: Number(r.messages),
      chars: Number(r.chars),
      tokens: Number(r.tokens),
    };
  }

  searchArchive(botId: string, query: string, page: Page): Paged<ArchiveHit> {
    // Every term is quoted, so user input can never be interpreted as FTS5 query syntax.
    const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);
    if (terms.length === 0) return { items: [], total: 0, ...page };
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const total = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? AND m.bot_id = ?',
        )
        .get(match, botId) as Row
    ).n as number;
    const rows = this.db
      .prepare(
        `SELECT m.id, m.import_id, m.seq, m.role, m.timestamp, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
         FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.bot_id = ?
         ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(match, botId, page.limit, page.offset) as Row[];
    return {
      items: rows.map((r) => ({
        messageId: r.id as string,
        importId: r.import_id as string,
        seq: Number(r.seq),
        role: r.role as string,
        timestamp: (r.timestamp as string | null) ?? null,
        snippet: r.snippet as string,
      })),
      total,
      ...page,
    };
  }

  // ------------------------------------------------------------------------------------------- checkpoints

  insertCheckpoint(ck: CheckpointRecord): void {
    const { reviewStatus, reviewedAt, reviewNote, ...immutable } = ck;
    this.db
      .transaction(() => {
        const head = this.db
          .prepare(
            'SELECT id, version FROM checkpoints WHERE bot_id = ? ORDER BY version DESC LIMIT 1',
          )
          .get(ck.botId) as Row | undefined;
        const headVersion = head ? Number(head.version) : 0;
        if (
          ck.version !== headVersion + 1 ||
          (ck.parentId ?? null) !== ((head?.id as string | undefined) ?? null)
        ) {
          throw new GcmError(
            'CONFLICT',
            `Checkpoint history for "${ck.botId}" changed concurrently (head is v${headVersion}). Retry the operation.`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO checkpoints (id, bot_id, version, parent_id, created_at, content_hash, review_status, reviewed_at, review_note, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ck.id,
            ck.botId,
            ck.version,
            ck.parentId,
            ck.createdAt,
            ck.contentHash,
            reviewStatus,
            reviewedAt,
            reviewNote,
            JSON.stringify(immutable),
          );
        const link = this.db.prepare(
          'INSERT OR IGNORE INTO checkpoint_imports (checkpoint_id, import_id, bot_id) VALUES (?, ?, ?)',
        );
        for (const importId of ck.source.importIds) link.run(ck.id, importId, ck.botId);
      })
      .immediate();
  }

  private rowToCheckpoint(r: Row): CheckpointRecord {
    const base = parse<Omit<CheckpointRecord, 'reviewStatus' | 'reviewedAt' | 'reviewNote'>>(
      r.data,
    );
    return {
      ...base,
      reviewStatus: r.review_status as CheckpointRecord['reviewStatus'],
      reviewedAt: (r.reviewed_at as string | null) ?? null,
      reviewNote: (r.review_note as string | null) ?? null,
    };
  }

  getCheckpoint(id: string): CheckpointRecord | null {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToCheckpoint(r) : null;
  }

  listCheckpoints(botId: string, page: Page): Paged<CheckpointRecord> {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE bot_id = ?').get(botId) as Row
    ).n as number;
    const items = (
      this.db
        .prepare(
          'SELECT * FROM checkpoints WHERE bot_id = ? ORDER BY version DESC LIMIT ? OFFSET ?',
        )
        .all(botId, page.limit, page.offset) as Row[]
    ).map((r) => this.rowToCheckpoint(r));
    return { items, total, ...page };
  }

  headCheckpoint(botId: string): CheckpointRecord | null {
    const r = this.db
      .prepare('SELECT * FROM checkpoints WHERE bot_id = ? ORDER BY version DESC LIMIT 1')
      .get(botId) as Row | undefined;
    return r ? this.rowToCheckpoint(r) : null;
  }

  coveredImportIds(botId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT import_id FROM checkpoint_imports WHERE bot_id = ?')
      .all(botId) as Row[];
    return new Set(rows.map((r) => r.import_id as string));
  }

  setCheckpointReview(
    id: string,
    status: 'unreviewed' | 'reviewed',
    at: string | null,
    note: string | null,
  ): void {
    const res = this.db
      .prepare(
        'UPDATE checkpoints SET review_status = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
      )
      .run(status, at, note, id);
    if (res.changes === 0) throw new GcmError('NOT_FOUND', `Checkpoint "${id}" not found.`);
  }

  // ------------------------------------------------------------------------------------------- handoffs

  insertHandoff(h: HandoffRecord): void {
    this.db
      .prepare(
        'INSERT INTO handoffs (id, bot_id, checkpoint_id, created_at, state, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(h.id, h.botId, h.checkpointId, h.createdAt, h.state, JSON.stringify(h));
  }

  updateHandoff(h: HandoffRecord): void {
    const res = this.db
      .prepare('UPDATE handoffs SET state = ?, data = ? WHERE id = ?')
      .run(h.state, JSON.stringify(h), h.id);
    if (res.changes === 0) throw new GcmError('NOT_FOUND', `Handoff "${h.id}" not found.`);
  }

  getHandoff(id: string): HandoffRecord | null {
    const r = this.db.prepare('SELECT data FROM handoffs WHERE id = ?').get(id) as Row | undefined;
    return r ? parse<HandoffRecord>(r.data) : null;
  }

  listHandoffs(botId: string | null, page: Page): Paged<HandoffRecord> {
    const where = botId ? 'WHERE bot_id = ?' : '';
    const args = botId ? [botId] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM handoffs ${where}`).get(...args) as Row
    ).n as number;
    const items = (
      this.db
        .prepare(
          `SELECT data FROM handoffs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, page.limit, page.offset) as Row[]
    ).map((r) => parse<HandoffRecord>(r.data));
    return { items, total, ...page };
  }

  // ------------------------------------------------------------------------------------------- usage, settings, cache

  insertUsage(r: UsageRecord): void {
    this.db
      .prepare('INSERT INTO usage_records (id, bot_id, recorded_at, data) VALUES (?, ?, ?, ?)')
      .run(r.id, r.botId, r.recordedAt, JSON.stringify(r));
  }

  listUsage(botId: string): UsageRecord[] {
    return (
      this.db
        .prepare('SELECT data FROM usage_records WHERE bot_id = ? ORDER BY recorded_at, id')
        .all(botId) as Row[]
    ).map((r) => parse<UsageRecord>(r.data));
  }

  getSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare('SELECT key, value FROM settings').all() as Row[])
      out[r.key as string] = parse(r.value);
    return out;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  cacheGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM cache WHERE key = ?').get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }

  cachePut(key: string, value: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO cache (key, value, created_at) VALUES (?, ?, ?)')
        .run(key, value, new Date().toISOString());
      this.db
        .prepare(
          `DELETE FROM cache WHERE key NOT IN (SELECT key FROM cache ORDER BY created_at DESC LIMIT ${CACHE_LIMIT})`,
        )
        .run();
    })();
  }

  // ------------------------------------------------------------------------------------------- operations

  logOperation(op: OperationRecord): void {
    this.db
      .prepare(
        `INSERT INTO operations (id, at, op, channel, bot_id, duration_ms, ok, detail, model_tokens, response_tokens)
         VALUES (@id, @at, @op, @channel, @botId, @durationMs, @ok, @detail, @modelTokens, @responseTokens)`,
      )
      .run({ ...op, ok: op.ok ? 1 : 0, detail: op.detail.slice(0, 300) });
    if (Math.random() < 0.01) {
      this.db
        .prepare(
          `DELETE FROM operations WHERE id NOT IN (SELECT id FROM operations ORDER BY at DESC LIMIT ${OPERATIONS_LIMIT})`,
        )
        .run();
    }
  }

  listOperations(opts: { botId?: string; limit: number }): OperationRecord[] {
    const rows = (
      opts.botId
        ? this.db
            .prepare('SELECT * FROM operations WHERE bot_id = ? ORDER BY at DESC LIMIT ?')
            .all(opts.botId, opts.limit)
        : this.db.prepare('SELECT * FROM operations ORDER BY at DESC LIMIT ?').all(opts.limit)
    ) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      at: r.at as string,
      op: r.op as string,
      channel: r.channel as string,
      botId: (r.bot_id as string | null) ?? null,
      durationMs: Number(r.duration_ms),
      ok: Number(r.ok) === 1,
      detail: r.detail as string,
      modelTokens: Number(r.model_tokens),
      responseTokens: Number(r.response_tokens),
    }));
  }

  operationTotals(botId?: string): {
    count: number;
    durationMs: number;
    modelTokens: number;
    responseTokens: number;
  } {
    const r = (
      botId
        ? this.db
            .prepare(
              'SELECT COUNT(*) AS c, COALESCE(SUM(duration_ms),0) AS d, COALESCE(SUM(model_tokens),0) AS m, COALESCE(SUM(response_tokens),0) AS t FROM operations WHERE bot_id = ?',
            )
            .get(botId)
        : this.db
            .prepare(
              'SELECT COUNT(*) AS c, COALESCE(SUM(duration_ms),0) AS d, COALESCE(SUM(model_tokens),0) AS m, COALESCE(SUM(response_tokens),0) AS t FROM operations',
            )
            .get()
    ) as Row;
    return {
      count: Number(r.c),
      durationMs: Number(r.d),
      modelTokens: Number(r.m),
      responseTokens: Number(r.t),
    };
  }

  // ------------------------------------------------------------------------------------------- API tokens

  insertApiToken(t: ApiTokenRecord): void {
    this.db
      .prepare(
        'INSERT INTO api_tokens (id, name, token_hash, bots, can_write, created_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        t.id,
        t.name,
        t.tokenHash,
        JSON.stringify(t.bots),
        t.canWrite ? 1 : 0,
        t.createdAt,
        t.revokedAt,
        t.lastUsedAt,
      );
  }

  private rowToToken(r: Row): ApiTokenRecord {
    return {
      id: r.id as string,
      name: r.name as string,
      tokenHash: r.token_hash as string,
      bots: parse<'*' | string[]>(r.bots),
      canWrite: Number(r.can_write) === 1,
      createdAt: r.created_at as string,
      revokedAt: (r.revoked_at as string | null) ?? null,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
    };
  }

  listApiTokens(): ApiTokenRecord[] {
    return (this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at').all() as Row[]).map(
      (r) => this.rowToToken(r),
    );
  }

  findApiTokenByHash(hash: string): ApiTokenRecord | null {
    const r = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash) as
      Row | undefined;
    return r ? this.rowToToken(r) : null;
  }

  touchApiToken(id: string, at: string): void {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  revokeApiToken(id: string, at: string): boolean {
    return (
      this.db
        .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(at, id).changes > 0
    );
  }

  // ------------------------------------------------------------------------------------------- admin

  deleteBotData(botId: string): DeletionCounts {
    return this.db.transaction(() => {
      const count = (sql: string) => Number((this.db.prepare(sql).get(botId) as Row).n);
      const counts: DeletionCounts = {
        bots: count('SELECT COUNT(*) AS n FROM bots WHERE id = ?'),
        imports: count('SELECT COUNT(*) AS n FROM imports WHERE bot_id = ?'),
        messages: count('SELECT COUNT(*) AS n FROM messages WHERE bot_id = ?'),
        checkpoints: count('SELECT COUNT(*) AS n FROM checkpoints WHERE bot_id = ?'),
        handoffs: count('SELECT COUNT(*) AS n FROM handoffs WHERE bot_id = ?'),
        usage: count('SELECT COUNT(*) AS n FROM usage_records WHERE bot_id = ?'),
      };
      this.db.prepare('DELETE FROM messages WHERE bot_id = ?').run(botId);
      this.db.prepare('DELETE FROM checkpoint_imports WHERE bot_id = ?').run(botId);
      for (const t of ['checkpoints', 'imports', 'handoffs', 'usage_records', 'operations']) {
        this.db.prepare(`DELETE FROM ${t} WHERE bot_id = ?`).run(botId);
      }
      this.db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
      // Analysis caches may embed this bot's content.
      this.db.prepare('DELETE FROM cache').run();
      return counts;
    })();
  }

  deleteAllData(): DeletionCounts {
    const bots = this.listBots().map((b) => b.id);
    const total: DeletionCounts = {
      bots: 0,
      imports: 0,
      messages: 0,
      checkpoints: 0,
      handoffs: 0,
      usage: 0,
    };
    for (const id of bots) {
      const c = this.deleteBotData(id);
      for (const k of Object.keys(total) as (keyof DeletionCounts)[]) total[k] += c[k];
    }
    this.db.transaction(() => {
      for (const t of ['cache', 'operations', 'api_tokens', 'settings'])
        this.db.prepare(`DELETE FROM ${t}`).run();
    })();
    this.db.exec('VACUUM');
    return total;
  }

  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
    restrictPermissions(destPath, 0o600);
  }

  integrityCheck(): string[] {
    const rows = this.db.pragma('integrity_check') as Row[];
    const msgs = rows.map((r) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
  }

  info(): StoreInfo {
    let fts = true;
    try {
      this.db.prepare('SELECT 1 FROM messages_fts WHERE messages_fts MATCH \'"x"\' LIMIT 1').all();
    } catch {
      fts = false;
    }
    return {
      path: this.dbPath,
      schemaVersion: this.schemaVersion(),
      sizeBytes: existsSync(this.dbPath) ? statSync(this.dbPath).size : 0,
      ftsEnabled: fts,
    };
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

function parse<T>(v: unknown): T {
  return JSON.parse(String(v)) as T;
}

function toMessage(r: Row): StoredMessage {
  const m: StoredMessage = {
    id: r.id as string,
    importId: r.import_id as string,
    botId: r.bot_id as string,
    seq: Number(r.seq),
    role: r.role as StoredMessage['role'],
    content: r.content as string,
    contentHash: r.content_hash as string,
  };
  if (r.author) m.author = r.author as string;
  if (r.timestamp) m.timestamp = r.timestamp as string;
  return m;
}
