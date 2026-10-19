/**
 * Local dashboard server: JSON API over GcmService + the built React client.
 *
 * Security model: binds to 127.0.0.1 only; every /api request must carry the per-launch session token that is
 * embedded in the served page (blocks other local web pages/CSRF); Host header must be the loopback address
 * (blocks DNS rebinding); no CORS; strict security headers.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  GcmError,
  isLoopbackUrl,
  loadTokenizer,
  type AccessContext,
  type GcmErrorCode,
  type GcmService,
  type PlatformAction,
  type ProfileName,
  type UsageInput,
} from '@gcm/core';

export interface DashboardOptions {
  port: number;
  /** Directory containing the built client (index.html + assets). */
  staticDir: string | null;
  sessionToken?: string;
  log?: (line: string) => void;
}

const STATUS: Record<GcmErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTEGRITY: 422,
  APPROVAL_REQUIRED: 428,
  INVALID_STATE: 409,
  LIMIT_EXCEEDED: 413,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const page = (q: Record<string, unknown>, max = 100) => ({
  limit: Math.min(max, Math.max(1, num(q.limit) ?? 20)),
  offset: Math.max(0, num(q.offset) ?? 0),
});

export function buildDashboardApp(
  service: GcmService,
  opts: DashboardOptions & { token: string },
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 }) as unknown as FastifyInstance;
  const ctx: AccessContext = { bots: '*', canWrite: true, channel: 'dashboard' };
  const tokenBuf = Buffer.from(opts.token);
  const allowedHosts = () => new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CSP);
    reply.header('cache-control', 'no-store');
    if (!allowedHosts().has(String(req.headers.host ?? '')))
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden host' } });
    if (req.url.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Cross-origin request blocked' } });
      }
      const got = Buffer.from(String(req.headers['x-gcm-session'] ?? ''));
      if (got.length !== tokenBuf.length || !timingSafeEqual(got, tokenBuf)) {
        return reply.code(401).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Missing or invalid dashboard session. Reload the page from `gcm dashboard`.',
          },
        });
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GcmError)
      return reply
        .code(STATUS[err.code])
        .send({ error: { code: err.code, message: err.message, hint: err.hint } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply
        .code(status)
        .send({ error: { code: 'VALIDATION', message: (err as Error).message } });
    opts.log?.(`[gcm-dashboard] internal error: ${(err as Error).name}`);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal error; no data was changed.' } });
  });

  // ------------------------------------------------------------------------------------------ overview & meta
  app.get('/api/overview', async () => {
    const bots = service.listBots(ctx);
    const recentCheckpoints = bots
      .flatMap((b) => service.listCheckpoints(b.id, ctx, { limit: 5, offset: 0 }).items)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((c) => ({
        id: c.id,
        botId: c.botId,
        version: c.version,
        createdAt: c.createdAt,
        reviewStatus: c.reviewStatus,
        tokens: c.tokenEstimate.tokens,
        conflicts: c.content.conflicts.length,
      }));
    const activeHandoffs = service
      .listHandoffs(null, ctx, { limit: 200, offset: 0 })
      .items.filter((h) => h.state !== 'CONTINUATION_VERIFIED')
      .slice(0, 10)
      .map((h) => ({
        id: h.id,
        botId: h.botId,
        state: h.state,
        createdAt: h.createdAt,
        tokens: h.tokenEstimate.tokens,
      }));
    const failures = service.store
      .listOperations({ limit: 200 })
      .filter((o) => !o.ok)
      .slice(0, 10)
      .map((o) => ({ at: o.at, op: o.op, botId: o.botId, code: o.detail }));
    return { bots, recentCheckpoints, activeHandoffs, failures };
  });
  app.get('/api/health', async () => service.health());
  app.get('/api/capabilities', async () => service.capabilities());
  app.get('/api/provider-status', async () => service.providerStatus());
  app.get('/api/settings', async () => ({
    settings: service.settings(),
    dataPath: service.store.info().path,
  }));
  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Body;
    // Defense in depth: the UI asks for consent before a non-local Ollama URL; enforce it server-side too.
    if (
      typeof body.ollamaUrl === 'string' &&
      body.ollamaUrl !== service.settings().ollamaUrl &&
      !isLoopbackUrl(body.ollamaUrl) &&
      body.allowRemote !== true
    ) {
      throw new GcmError(
        'APPROVAL_REQUIRED',
        'A non-local Ollama URL would send checkpoint notes off this machine.',
        'Tick the acknowledgement to confirm.',
      );
    }
    const { allowRemote: _allowRemote, ...patch } = body;
    const next = service.updateSettings(patch, ctx);
    await loadTokenizer(next.tokenMethod);
    return next;
  });
  app.get('/api/mcp', async () => ({
    tokens: service.store.listApiTokens().map((t) => ({
      id: t.id,
      name: t.name,
      bots: t.bots,
      canWrite: t.canWrite,
      createdAt: t.createdAt,
      revokedAt: t.revokedAt,
      lastUsedAt: t.lastUsedAt,
    })),
  }));

  // ------------------------------------------------------------------------------------------ bots
  app.get('/api/bots', async () => service.listBots(ctx));
  app.post('/api/bots', async (req) => {
    const { createOnly, ...patch } = (req.body ?? {}) as Body;
    // "Add bot" must never silently overwrite an existing profile.
    if (createOnly === true && typeof patch.id === 'string' && service.store.getBot(patch.id)) {
      throw new GcmError(
        'CONFLICT',
        `Bot "${patch.id}" already exists.`,
        'Open it and use “Edit profile” instead.',
      );
    }
    return service.upsertBot(patch as never, ctx);
  });
  app.get<{ Params: { id: string } }>('/api/bots/:id', async (req) => {
    const bot = service.getBot(req.params.id, ctx);
    const summary = service.listBots(ctx).find((b) => b.id === bot.id) ?? null;
    return { bot, summary };
  });
  app.get<{ Params: { id: string }; Querystring: Body }>('/api/bots/:id/imports', async (req) =>
    service.listImports(req.params.id, ctx, page(req.query)),
  );
  app.post<{ Params: { id: string } }>('/api/bots/:id/import', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.importContext(
      {
        botId: req.params.id,
        text: String(b.text ?? ''),
        format: (str(b.format) as never) ?? 'auto',
        sessionRef: str(b.sessionRef) ?? null,
        sourceName: str(b.sourceName) ?? 'dashboard',
        completeness: (str(b.completeness) as never) ?? 'unknown',
        assistantNames: Array.isArray(b.assistantNames) ? (b.assistantNames as string[]) : [],
        userNames: Array.isArray(b.userNames) ? (b.userNames as string[]) : [],
      },
      ctx,
      { dryRun: b.dryRun === true },
    );
  });
  const ckParams = (id: string, b: Body) => ({
    botId: id,
    profile: str(b.profile) as ProfileName | undefined,
    budgetTokens: num(b.budgetTokens),
    objective: str(b.objective) ?? null,
    workstream: str(b.workstream) ?? null,
    rebuild: b.rebuild === true,
  });
  app.post<{ Params: { id: string } }>('/api/bots/:id/analyze', async (req) => {
    const p = service.analyze(ckParams(req.params.id, (req.body ?? {}) as Body), ctx);
    return { ...p, result: { ...p.result, items: p.result.items.slice(0, 2000) } };
  });
  app.post<{ Params: { id: string } }>('/api/bots/:id/checkpoints', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.createCheckpoint(
      {
        ...ckParams(req.params.id, b),
        approve: b.approve === true,
        reviewNote: str(b.note) ?? null,
      },
      ctx,
    );
  });
  app.get<{ Params: { id: string }; Querystring: Body }>('/api/bots/:id/checkpoints', async (req) =>
    service.listCheckpoints(req.params.id, ctx, page(req.query)),
  );
  app.get<{ Params: { id: string }; Querystring: Body }>('/api/bots/:id/handoffs', async (req) =>
    service.listHandoffs(req.params.id, ctx, page(req.query)),
  );
  app.post<{ Params: { id: string } }>('/api/bots/:id/handoffs', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.prepareHandoff(
      {
        botId: req.params.id,
        checkpointId: str(b.checkpointId),
        profile: str(b.profile) as ProfileName | undefined,
        budgetTokens: num(b.budgetTokens),
        allowUnreviewed: b.allowUnreviewed === true,
      },
      ctx,
    );
  });
  app.get<{ Params: { id: string }; Querystring: Body }>(
    '/api/bots/:id/archive/search',
    async (req) =>
      service.searchArchive(req.params.id, String(req.query.q ?? ''), ctx, page(req.query, 50)),
  );
  app.get<{ Params: { id: string } }>('/api/bots/:id/usage', async (req) =>
    service.usageReport(req.params.id, ctx),
  );
  app.post<{ Params: { id: string } }>('/api/bots/:id/usage', async (req) =>
    service.recordUsage({ ...((req.body ?? {}) as UsageInput), botId: req.params.id }, ctx),
  );

  // ------------------------------------------------------------------------------------------ checkpoints
  app.get<{ Querystring: Body }>('/api/checkpoints/diff', async (req) =>
    service.diff(String(req.query.from ?? ''), String(req.query.to ?? ''), ctx),
  );
  app.post('/api/checkpoints/import', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.importCheckpointFile(String(b.json ?? ''), ctx, { asBot: str(b.asBot) });
  });
  app.get<{ Params: { id: string } }>('/api/checkpoints/:id', async (req) =>
    service.getCheckpoint(req.params.id, ctx),
  );
  app.get<{ Params: { id: string } }>('/api/checkpoints/:id/verify', async (req) =>
    service.verifyCheckpoint(req.params.id, ctx),
  );
  app.post<{ Params: { id: string } }>('/api/checkpoints/:id/review', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.reviewCheckpoint(req.params.id, ctx, {
      note: str(b.note) ?? null,
      status: b.status === 'unreviewed' ? 'unreviewed' : 'reviewed',
    });
  });
  app.post<{ Params: { id: string } }>('/api/checkpoints/:id/restore', async (req) =>
    service.restoreCheckpoint(req.params.id, ctx),
  );
  app.get<{ Params: { id: string }; Querystring: Body }>(
    '/api/checkpoints/:id/export',
    async (req, reply) => {
      const format = req.query.format === 'markdown' ? 'markdown' : 'json';
      const body = service.exportCheckpoint(req.params.id, format, ctx);
      return reply
        .header(
          'content-type',
          format === 'json' ? 'application/json' : 'text/markdown; charset=utf-8',
        )
        .header(
          'content-disposition',
          `attachment; filename="gcm-checkpoint-${req.params.id}.${format === 'json' ? 'json' : 'md'}"`,
        )
        .send(body);
    },
  );

  // ------------------------------------------------------------------------------------------ handoffs
  app.get<{ Params: { id: string } }>('/api/handoffs/:id', async (req) =>
    service.getHandoff(req.params.id, ctx),
  );
  app.post<{ Params: { id: string } }>('/api/handoffs/:id/action', async (req) => {
    const b = (req.body ?? {}) as Body;
    return service.chooseAction(req.params.id, String(b.action) as PlatformAction, ctx, {
      acknowledgeDestructive: b.acknowledgeDestructive === true,
    });
  });
  app.post<{ Params: { id: string } }>('/api/handoffs/:id/done', async (req) =>
    service.reportActionDone(req.params.id, ctx, str(((req.body ?? {}) as Body).note)),
  );
  app.post<{ Params: { id: string } }>('/api/handoffs/:id/verify', async (req) =>
    service.verifyContinuationReply(
      req.params.id,
      String(((req.body ?? {}) as Body).reply ?? ''),
      ctx,
    ),
  );
  app.post<{ Params: { id: string } }>('/api/handoffs/:id/retry', async (req) =>
    service.retryHandoff(req.params.id, ctx),
  );

  // ------------------------------------------------------------------------------------------ static client
  const staticDir =
    opts.staticDir && existsSync(path.join(opts.staticDir, 'index.html'))
      ? path.resolve(opts.staticDir)
      : null;
  const indexHtml = () => {
    if (!staticDir) {
      return `<!doctype html><meta charset="utf-8"><title>GCM dashboard</title><body style="font-family:system-ui;padding:2rem"><h1>Dashboard assets not built</h1><p>Run <code>pnpm build</code> in the repository, then start <code>gcm dashboard</code> again. The API is running.</p></body>`;
    }
    return readFileSync(path.join(staticDir, 'index.html'), 'utf8').replace(
      '<!--GCM_SESSION-->',
      `<meta name="gcm-session" content="${opts.token}">`,
    );
  };
  const sendFile = (reply: FastifyReply, rel: string) => {
    if (!staticDir) return reply.code(404).send('Not found');
    const target = path.resolve(staticDir, rel);
    if (
      !target.startsWith(staticDir + path.sep) ||
      !existsSync(target) ||
      !statSync(target).isFile()
    )
      return reply.code(404).send('Not found');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply
      .type(MIME[path.extname(target)] ?? 'application/octet-stream')
      .send(readFileSync(target));
  };
  app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) =>
    sendFile(reply, path.join('assets', req.params['*'])),
  );
  app.get('/favicon.svg', async (_req, reply) => sendFile(reply, 'favicon.svg'));
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/'))
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    return reply.type('text/html; charset=utf-8').send(indexHtml());
  });
  return app;
}

export async function startDashboard(
  service: GcmService,
  opts: DashboardOptions,
): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  await loadTokenizer(service.settings().tokenMethod);
  const token = opts.sessionToken ?? randomBytes(24).toString('hex');
  const state = { ...opts, token };
  const app = buildDashboardApp(service, state);
  await app.listen({ host: '127.0.0.1', port: opts.port });
  const address = app.server.address();
  if (typeof address === 'object' && address) state.port = address.port;
  return { url: `http://127.0.0.1:${state.port}/`, token, close: () => app.close() };
}
