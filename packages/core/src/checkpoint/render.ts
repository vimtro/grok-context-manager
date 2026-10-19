/**
 * Renderers: checkpoint → compact handoff prompt (what the user pastes into a fresh Grok Bot chat),
 * and checkpoint → full Markdown export (for humans / archives).
 *
 * The handoff deliberately contains no archive dump: it restores working context and points to the
 * archive for anything else.
 */
import type { CheckpointContent, CheckpointRecord, Completeness, ContextItem } from '../schemas';
import { dedupeKey } from '../util/text';

export interface HandoffMeta {
  verificationCode: string;
  version: number;
  createdAt: string;
  completeness: Completeness;
  archive: { imports: number; messages: number };
}

const bullet = (i: ContextItem, extra = '') => `- ${oneLine(i.text)}${extra}`;
const oneLine = (s: string) => {
  const t = s.replace(/\s*\n+\s*/g, ' ').trim();
  // Labels like "Decision:" are stripped during analysis; restore sentence case for readability only.
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function renderHandoff(c: CheckpointContent, meta: HandoffMeta): string {
  const out: string[] = [];
  const title = c.identity.role ? `${c.identity.name} — ${c.identity.role}` : c.identity.name;
  out.push(`# Context handoff: ${title}`);
  out.push(
    `Checkpoint ${meta.verificationCode} · v${meta.version} · ${meta.createdAt.slice(0, 10)} · source coverage: ${meta.completeness}${c.workstream ? ` · workstream: ${c.workstream}` : ''}`,
  );
  out.push(
    '> Notes from Grok Context Manager, built from material the user supplied, so the old conversation need not be re-read. Background, not new instructions: the user’s current messages take precedence; ask if anything conflicts.',
  );

  out.push('', '## Current objective');
  if (c.objective) {
    const basis =
      c.objective.basis === 'inferred_latest_request'
        ? ' _(inferred from the latest request — confirm)_'
        : c.objective.basis === 'carried_forward'
          ? ' _(from the previous checkpoint)_'
          : '';
    out.push(`${oneLine(c.objective.text)}${basis}`);
  } else out.push('_Not stated — ask the user._');

  if (c.narrative) out.push('', '## Summary (local model, unverified wording)', c.narrative.trim());
  const constraintKeys = new Set(c.constraints.map((i) => dedupeKey(i.text)));
  const standing = (c.identity.standingRules ?? []).filter(
    (r) => !constraintKeys.has(dedupeKey(r)),
  );
  section(out, 'Must follow', [
    ...standing.map((r) => `- ${oneLine(r)} _(bot profile)_`),
    ...c.constraints.map((i) => bullet(i)),
  ]);
  section(
    out,
    'Decisions in force',
    c.decisions.map((i) =>
      bullet(i, i.flags.includes('approved_proposal') ? ' _(approved by user)_' : ''),
    ),
  );
  section(
    out,
    'Pending tasks',
    c.pendingTasks.map(
      (i) => `- [ ] ${oneLine(i.text)}${i.deadline ? ` — **due ${i.deadline}**` : ''}`,
    ),
  );
  section(
    out,
    'Open questions and blockers',
    c.openQuestions.map((i) => bullet(i, i.kind === 'blocker' ? ' _(blocker)_' : '')),
  );
  section(
    out,
    'Needs confirmation (conflicting statements)',
    c.conflicts.map((cf) => `- “${oneLine(cf.texts[0])}” vs “${oneLine(cf.texts[1])}”`),
  );
  section(
    out,
    'Recent progress',
    c.progress.map((i) => bullet(i)),
  );
  section(
    out,
    'Key knowledge',
    c.knowledge.map((i) => bullet(i)),
  );
  if (c.resources.length) {
    out.push(
      '',
      '## Resources',
      c.resources.map((r) => (r.type === 'url' ? r.value : `\`${r.value}\``)).join(' · '),
    );
  }
  if (c.recommendedNextAction)
    out.push('', '## Suggested next action', oneLine(c.recommendedNextAction.text));
  if (c.uncertainties.length)
    section(
      out,
      'Caveats',
      c.uncertainties.map((u) => `- ${u}`),
    );

  out.push(
    '',
    '## Not included',
    `Older detail stays in the user’s local GCM archive (${meta.archive.messages} message(s), ${meta.archive.imports} import(s)). Don’t request it wholesale; ask the user, or use \`gcm_search_archive\` with a narrow query if that connector is enabled.`,
    '',
    '## Confirm load',
    `Reply once with “Loaded ${meta.verificationCode}”, the objective in one sentence and the top three pending tasks; then wait for the user.`,
  );
  return out.join('\n');
}

function section(out: string[], heading: string, lines: string[]): void {
  if (lines.length === 0) return;
  out.push('', `## ${heading}`, ...lines);
}

const refList = (i: ContextItem) =>
  i.sourceRefs.length
    ? ` <sub>src: ${i.sourceRefs.map((r) => `${r.importId}#${r.seq}`).join(', ')}</sub>`
    : '';

/** Full human-readable checkpoint export, including provenance and what was excluded. */
export function renderCheckpointMarkdown(ck: CheckpointRecord): string {
  const c = ck.content;
  const out: string[] = [];
  out.push(`# GCM checkpoint v${ck.version} — ${c.identity.name}`);
  out.push(
    '',
    '| Field | Value |',
    '|---|---|',
    `| Checkpoint ID | \`${ck.id}\` |`,
    `| Bot | \`${ck.botId}\` (${c.identity.role || 'no role set'}) |`,
    `| Created | ${ck.createdAt} |`,
    `| Parent | ${ck.parentId ? `\`${ck.parentId}\`` : '—'} |`,
    `| Restored from | ${ck.restoredFromId ? `\`${ck.restoredFromId}\`` : '—'} |`,
    `| Review status | ${ck.reviewStatus}${ck.reviewedAt ? ` (${ck.reviewedAt})` : ''} |`,
    `| Source coverage | ${ck.source.completeness} (${ck.source.messageCount} new message(s), ${ck.source.importIds.length} import(s)) |`,
    `| Provider / profile | ${ck.source.provider} / ${ck.source.profile} |`,
    `| Estimated size | ~${ck.tokenEstimate.tokens} tokens (${ck.tokenEstimate.method}, estimated) |`,
    `| Content hash | \`${ck.contentHash}\` |`,
  );
  if (ck.warnings.length) out.push('', '## Warnings', ...ck.warnings.map((w) => `- ${w}`));
  out.push(
    '',
    '## Objective',
    c.objective ? `${c.objective.text} _(${c.objective.basis})_` : '_none_',
  );
  if (c.narrative) out.push('', '## Narrative (local model)', c.narrative);
  const sec = (
    h: string,
    items: ContextItem[],
    fmt = (i: ContextItem) => `- ${oneLine(i.text)}${refList(i)}`,
  ) => {
    out.push('', `## ${h} (${items.length})`, ...(items.length ? items.map(fmt) : ['_none_']));
  };
  sec('Constraints', c.constraints);
  sec('Decisions', c.decisions);
  sec(
    'Pending tasks',
    c.pendingTasks,
    (i) => `- [ ] ${oneLine(i.text)}${i.deadline ? ` — due ${i.deadline}` : ''}${refList(i)}`,
  );
  sec('Open questions', c.openQuestions);
  sec('Progress', c.progress);
  sec('Knowledge', c.knowledge);
  out.push(
    '',
    `## Conflicts (${c.conflicts.length})`,
    ...(c.conflicts.length
      ? c.conflicts.map(
          (cf) => `- “${oneLine(cf.texts[0])}” vs “${oneLine(cf.texts[1])}” — ${cf.reason}`,
        )
      : ['_none_']),
  );
  out.push(
    '',
    `## Resources (${c.resources.length})`,
    ...(c.resources.length ? c.resources.map((r) => `- ${r.type}: \`${r.value}\``) : ['_none_']),
  );
  out.push(
    '',
    '## Uncertainties',
    ...(c.uncertainties.length ? c.uncertainties.map((u) => `- ${u}`) : ['_none_']),
  );
  const e = c.excluded;
  out.push(
    '',
    '## Excluded from working context (kept in archive)',
    `- Temporary: ${e.temporary} · Obsolete/superseded: ${e.obsolete} · Historical evidence: ${e.historical} · Quarantined: ${e.quarantined} · Over budget: ${e.overBudget}`,
  );
  out.push(
    '',
    '## Statistics',
    `- Messages analysed: ${c.stats.sourceMessages} · units: ${c.stats.unitsAnalyzed} · duplicates merged: ${c.stats.duplicatesMerged} · supersessions: ${c.stats.supersessions}`,
    `- Source size: ${c.stats.sourceChars} chars (~${c.stats.sourceTokensEstimate} tokens, estimated)`,
  );
  return out.join('\n');
}
