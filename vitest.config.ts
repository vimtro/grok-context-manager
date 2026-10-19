import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Avoid resolving "localhost" (fails intermittently in some sandboxed Windows shells).
  server: { host: '127.0.0.1' },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
