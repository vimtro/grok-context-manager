import { GcmService, type ServiceOptions } from '@gcm/core';
import { defaultDataDir } from './paths';
import { SqliteStore } from './sqlite-store';

export * from './paths';
export { SqliteStore, MIGRATIONS, LATEST_SCHEMA_VERSION, type OpenOptions } from './sqlite-store';

/** Opens the store in `dataDir` (default: platform data dir / GCM_HOME) and returns a ready service. */
export function openService(
  dataDir?: string,
  opts: ServiceOptions = {},
): { service: GcmService; store: SqliteStore } {
  const store = SqliteStore.open({ dataDir: dataDir ?? defaultDataDir() });
  return { service: new GcmService(store, opts), store };
}
