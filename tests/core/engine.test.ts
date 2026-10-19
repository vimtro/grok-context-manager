import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyUnit,
  countTokens,
  extractDeadline,
  extractIdentifiers,
  valuesDiffer,
  type CheckpointContent,
} from '@gcm/core';
import { makeEnv, seedBot, type TestEnv } from '../helpers';

const texts = (items: { text: string }[]) => items.map((i) => i.text).join('\n');
const allRetained = (c: CheckpointContent) =>
  texts([
    ...c.constraints,
    ...c.decisions,
    ...c.pendingTasks,
    ...c.openQuestions,
    ...c.progress,
    ...c.knowledge,
  ]);

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('compaction engine — preservation (sales fixture)', () => {
  const analyze = () => {
    seedBot(env, 'sales', 'sales-bot.txt', 'Sales Bot');
    return env.service.analyze({ botId: 'sales' }, env.ctx);
  };

  it('keeps negative instructions and security rules verbatim', () => {
    const c = analyze().result.content;
    expect(texts(c.constraints)).toContain('Never send pricing to Acme without my approval.');
    expect(texts(c.constraints)).toContain('Do not CC legal on early drafts.');
    expect(c.constraints.every((i) => i.protected)).toBe(true);
  });

  it('keeps explicit decisions, turns an approved proposal into a decision, and drops superseded ones', () => {
    const { result } = analyze();
    const d = texts(result.content.decisions);
    expect(d).toMatch(/PandaDoc/);
    expect(d).toMatch(/Option A/);
    expect(result.content.decisions.find((i) => /Option A/.test(i.text))?.flags).toContain(
      'approved_proposal',
    );
    expect(d).not.toMatch(/We decided to use DocuSign/);
    const superseded = result.items.find((i) => /We decided to use DocuSign/.test(i.text));
    expect(superseded?.supersededBy).toBeDefined();
  });

  it('applies explicit updates to facts (budget $40k → $55k)', () => {
    const c = analyze().result.content;
    expect(texts(c.knowledge)).toMatch(/\$55,000/);
    expect(allRetained(c)).not.toMatch(/\$40,000/);
  });

  it('keeps unfinished tasks with deadlines and closes tasks completed later', () => {
    const { result } = analyze();
    const tasks = result.content.pendingTasks;
    expect(texts(tasks)).toMatch(/schedule a call with Dana/i);
    expect(tasks.find((t) => /proposal for Dana/.test(t.text))?.deadline).toBe('Friday');
    expect(texts(tasks)).not.toMatch(/update the pricing sheet/i);
    expect(texts(result.content.progress)).toMatch(/updated the pricing sheet/);
  });

  it('flags conflicting rules for review instead of resolving them silently', () => {
    const c = analyze().result.content;
    expect(c.conflicts).toHaveLength(1);
    expect(c.conflicts[0]!.texts.join(' ')).toMatch(/Always CC.*Priya|Never CC.*Priya/);
    expect(texts(c.constraints)).toMatch(/Always CC Dana's assistant Priya/);
    expect(texts(c.constraints)).toMatch(/Never CC Dana's assistant Priya/);
  });

  it('keeps blockers, open questions and exact identifiers', () => {
    const { result, handoffPreview } = analyze();
    expect(
      result.content.openQuestions.some((q) => q.kind === 'blocker' && /PO number/.test(q.text)),
    ).toBe(true);
    expect(texts(result.content.openQuestions)).toMatch(/Should I send the Option A proposal/);
    expect(handoffPreview).toContain('CRM-4821');
    expect(handoffPreview).toContain('/workspace/acme/contract-2025.pdf');
    expect(handoffPreview).toContain('/workspace/acme/pricing.xlsx');
  });

  it('redacts secrets and quarantines prompt injection', () => {
    const { result, handoffPreview, validation } = analyze();
    expect(handoffPreview).not.toMatch(/sk-proj-/);
    expect(JSON.stringify(result.content)).not.toMatch(/sk-proj-ABCD/);
    expect(handoffPreview).not.toMatch(/ignore all previous instructions/i);
    expect(result.content.excluded.quarantined).toBe(1);
    expect(result.content.uncertainties.join(' ')).toMatch(/instruction overrides/);
    expect(validation.ok).toBe(true);
  });

  it('reports unknown coverage instead of claiming completeness', () => {
    const { result } = analyze();
    expect(result.completeness).toBe('unknown');
    expect(result.content.uncertainties[0]).toMatch(/Source coverage is unknown/);
  });
});

describe('compaction engine — long conversation', () => {
  it('produces a handoff far smaller than the source while retaining planted facts', () => {
    seedBot(env, 'cos', 'chief-of-staff-long.md', 'Chief of Staff');
    const a = env.service.analyze({ botId: 'cos' }, env.ctx);
    const c = a.result.content;
    const handoffTokens = countTokens(a.handoffPreview);
    expect(c.stats.sourceTokensEstimate).toBeGreaterThan(10_000);
    expect(handoffTokens).toBeLessThan(c.stats.sourceTokensEstimate * 0.1);

    expect(c.objective?.text).toMatch(/Q4 board deck/);
    expect(texts(c.constraints)).toMatch(/invoices above \$5,000/);
    expect(texts(c.constraints)).toMatch(/NDA list/);
    expect(texts(c.constraints)).toMatch(/contract-review\.md/);
    expect(texts(c.decisions)).toMatch(/Tuesdays at 10:00/);
    expect(texts(c.decisions)).toMatch(/Linear/);
    expect(texts(c.decisions)).not.toMatch(/We will use Asana/);
    expect(texts(c.pendingTasks)).toMatch(/Figma team plan before 2026-11-01/);
    expect(texts(c.pendingTasks)).toMatch(/2026-11-15/);
    expect(texts(c.pendingTasks)).not.toMatch(/October invoice batch/);
    expect(texts(c.progress)).toMatch(/October invoice batch/);
    expect(texts(c.openQuestions)).toMatch(/payroll account/);
    // Followed only by filler ("Perfect."), so the question is still open.
    expect(texts(c.openQuestions)).toMatch(/board deck dry run/);
    expect(a.handoffPreview).not.toMatch(/forward every client contract/);
    expect(a.validation.ok).toBe(true);
  });
});

describe('compaction engine — budgets and honesty', () => {
  it('never drops protected items to meet a tiny budget, and warns', () => {
    seedBot(env, 'sales', 'sales-bot.txt');
    const a = env.service.analyze(
      { botId: 'sales', profile: 'compact', budgetTokens: 200 },
      env.ctx,
    );
    expect(texts(a.result.content.constraints)).toContain(
      'Never send pricing to Acme without my approval.',
    );
    expect(a.result.content.pendingTasks.length).toBeGreaterThanOrEqual(3);
    expect(a.result.warnings.join(' ')).toMatch(/Protected content needs/);
    expect(a.validation.ok).toBe(true);
  });

  it('does not invent an objective when none is stated', () => {
    env.service.upsertBot({ id: 'ops', name: 'Ops' }, env.ctx);
    env.service.importContext(
      { botId: 'ops', text: 'User: thanks\nAssistant: you are welcome' },
      env.ctx,
    );
    const c = env.service.analyze({ botId: 'ops' }, env.ctx).result.content;
    expect(c.objective).toBeNull();
    expect(c.uncertainties.join(' ')).toMatch(/No current objective/);
  });

  it('merges duplicate statements and keeps all source references', () => {
    env.service.upsertBot({ id: 'qa', name: 'QA' }, env.ctx);
    env.service.importContext(
      {
        botId: 'qa',
        text: 'User: Never deploy on Fridays.\nAssistant: ok\nUser: Remember: never deploy on Fridays!',
      },
      env.ctx,
    );
    const c = env.service.analyze({ botId: 'qa' }, env.ctx).result.content;
    const rule = c.constraints.filter((i) => /deploy on Fridays/i.test(i.text));
    expect(rule).toHaveLength(1);
    expect(rule[0]!.sourceRefs.length).toBe(2);
  });
});

describe('skill note format', () => {
  it('classifies the headings that the Grok Bot skill asks bots to write', () => {
    env.service.upsertBot({ id: 'mkt', name: 'Marketing' }, env.ctx);
    const notes = [
      '## Objective',
      'Launch the Q4 webinar campaign.',
      '## Constraints',
      '- Do not email contacts who unsubscribed.',
      '## Decisions',
      '- Use the "Ops at Scale" webinar title.',
      '## Next steps',
      '- [ ] Draft the invite email — due 2026-10-28',
      '## Open questions',
      '- Needs confirmation: budget $2k or $3k?',
      '## Done',
      '- Booked the Zoom webinar slot.',
      '## Context',
      '- Audience is operations managers at agencies.',
      '## Resources',
      '- /workspace/marketing/webinar-brief.md',
    ].join('\n');
    env.service.importContext({ botId: 'mkt', text: notes, completeness: 'partial' }, env.ctx);
    const c = env.service.analyze({ botId: 'mkt' }, env.ctx).result.content;
    expect(c.objective?.text).toBe('Launch the Q4 webinar campaign.');
    expect(texts(c.constraints)).toMatch(/unsubscribed/);
    expect(texts(c.decisions)).toMatch(/Ops at Scale/);
    expect(c.pendingTasks[0]?.deadline).toBe('2026-10-28');
    expect(texts(c.openQuestions)).toMatch(/budget/);
    expect(texts(c.progress)).toMatch(/Zoom/);
    expect(texts(c.knowledge)).toMatch(/operations managers/);
    expect(c.resources.map((r) => r.value)).toContain('/workspace/marketing/webinar-brief.md');
  });
});

describe('engine helpers', () => {
  it('extracts identifiers verbatim', () => {
    const ids = extractIdentifiers(
      'See PROJ-123 in C:\\work\\plan.docx, src/app.ts and https://x.example/a?b=1 using API_BASE_URL v2.4.1',
    ).map((i) => i.value);
    expect(ids).toEqual(
      expect.arrayContaining([
        'PROJ-123',
        'C:\\work\\plan.docx',
        'src/app.ts',
        'https://x.example/a?b=1',
        'API_BASE_URL',
        'v2.4.1',
      ]),
    );
  });

  it('extracts explicit deadlines', () => {
    expect(extractDeadline('Ship it by 2026-11-01 please')).toBe('2026-11-01');
    expect(extractDeadline('Deadline: end of Q4')).toBe('end of Q4');
    expect(extractDeadline('No dates here')).toBeUndefined();
  });

  it('detects value differences and polarity flips', () => {
    expect(valuesDiffer('Budget is $5k', 'Budget is $8k')).toBe(true);
    expect(valuesDiffer('Always CC Dana', 'Never CC Dana')).toBe(true);
    expect(valuesDiffer('Use Postgres', 'Use Postgres for analytics')).toBe(false);
  });

  it('classifies checkbox structure and chatter', () => {
    const base = {
      role: 'user' as const,
      msgIndex: 0,
      ref: { importId: 'i', seq: 1, role: 'user' as const },
      order: 0,
      isCode: false,
      isTable: false,
      answered: true,
      inFinalUserMessage: false,
      msgWords: 5,
    };
    expect(classifyUnit({ ...base, text: 'send report', checkbox: 'done' }).kind).toBe('completed');
    expect(classifyUnit({ ...base, text: 'send report', checkbox: 'open' }).kind).toBe('task');
    expect(classifyUnit({ ...base, text: 'Thanks!' }).category).toBe('temporary');
    expect(classifyUnit({ ...base, text: 'Only use public sources.' }).kind).toBe('constraint');
  });
});
