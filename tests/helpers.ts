import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GcmService, LOCAL_ACCESS, type AccessContext } from '@gcm/core';
import { SqliteStore } from '@gcm/storage';

export const ROOT = path.resolve(__dirname, '..');
export const fixture = (name: string) =>
  readFileSync(path.join(ROOT, 'examples', 'conversations', name), 'utf8');

export interface TestEnv {
  dir: string;
  store: SqliteStore;
  service: GcmService;
  ctx: AccessContext;
  cleanup: () => void;
}

export function makeEnv(opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}): TestEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcm-test-'));
  const store = SqliteStore.open({ dataDir: dir });
  const service = new GcmService(store, opts);
  return {
    dir,
    store,
    service,
    ctx: LOCAL_ACCESS,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Registers a bot and imports a fixture; returns the import record. */
export function seedBot(env: TestEnv, botId: string, file: string, name = botId) {
  env.service.upsertBot({ id: botId, name, role: `${name} specialist` }, env.ctx);
  const res = env.service.importContext({ botId, text: fixture(file), sourceName: file }, env.ctx);
  if (!res.import) throw new Error('seed import failed');
  return res.import;
}
