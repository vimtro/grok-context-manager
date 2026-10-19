/**
 * Smart context compaction: parse → normalise → classify → dedupe → resolve supersession →
 * flag conflicts → select within a token budget → validate.
 *
 * Deterministic and extractive: retained items keep their source wording (with secrets redacted), so a
 * checkpoint never changes the meaning of a decision. Protected items (constraints, decisions, open tasks,
 * open questions, deadlines, conflicts) are never dropped to meet a budget.
 */
import type {
  BotProfile,
  CheckpointContent,
  CheckpointRecord,
  Completeness,
  Conflict,
  ContextItem,
  ImportRecord,
  ProfileName,
  Resource,
  SourceRef,
  StoredMessage,
} from '../schemas';
import { redactSecrets } from '../security/redact';
import { countTokens, type TokenMethod } from '../tokens/estimate';
import { hashObject, sha256 } from '../util/hash';
import { contentWords, dedupeKey, jaccard, overlap, truncateText, wordCount } from '../util/text';
import {
  AFFIRMATION,
  classifyUnit,
  PROPOSAL_SENTENCE,
  segmentMessages,
  type Classification,
  type Unit,
} from './classify';
import { DATE_RE, extractIdentifiers } from './extract';
import { renderHandoff, type HandoffMeta } from '../checkpoint/render';

export const PROFILE_LIMITS: Record<
  ProfileName,
  { progress: number; knowledge: number; resources: number; maxItemChars: number }
> = {
  compact: { progress: 3, knowledge: 8, resources: 10, maxItemChars: 280 },
  balanced: { progress: 6, knowledge: 20, resources: 25, maxItemChars: 500 },
  detailed: { progress: 15, knowledge: 50, resources: 60, maxItemChars: 1200 },
};

const MAX_REFS_PER_ITEM = 12;

export interface CompactInput {
  bot: BotProfile;
  messages: StoredMessage[];
  imports: ImportRecord[];
  previous: CheckpointRecord | null;
  profile: ProfileName;
  budgetTokens: number;
  tokenMethod?: TokenMethod;
  workstream?: string | null;
  /** Objective stated by the user at checkpoint time (takes precedence over inference). */
  objective?: string | null;
}

export interface CompactResult {
  content: CheckpointContent;
  /** Every classified item including excluded ones (for the review preview). */
  items: ContextItem[];
  warnings: string[];
  completeness: Completeness;
  handoffPreviewTokens: number;
}

export function combineCompleteness(values: Completeness[]): Completeness {
  if (values.length === 0) return 'unknown';
  if (values.includes('partial')) return 'partial';
  if (values.every((v) => v === 'complete')) return 'complete';
  return 'unknown';
}

export function compact(input: CompactInput): CompactResult {
  const method = input.tokenMethod ?? 'heuristic';
  const limits = PROFILE_LIMITS[input.profile];
  const warnings: string[] = [];

  // 1–3. Segment and classify (parsing/normalisation happened at import time).
  const units = segmentMessages(input.messages);
  let items: ContextItem[] = units.map((u) => makeItem(u.text, classifyUnit(u), [u.ref], u.order));
  items.push(...approvedProposals(input.messages, units));

  // Incremental: carry forward the previous checkpoint's retained items (older than all new material).
  if (input.previous) items = [...carryForward(input.previous), ...items];

  // 4. Deduplicate.
  const deduped = dedupe(items);
  items = deduped.items;

  // 5. Explicit supersession and conflict detection (evidence-based only).
  const { conflicts, supersessions } = resolveSupersession(items);

  // Objective.
  const objective = chooseObjective(input, items);

  // 6. Select sections, applying per-item length caps.
  const live = (i: ContextItem) => !i.supersededBy && !i.flags.includes('injection_suspect');
  const byOrder = (a: ContextItem, b: ContextItem) => a.order - b.order;
  const recentFirst = (a: ContextItem, b: ContextItem) => b.order - a.order;
  const cap = (i: ContextItem) =>
    capText(i, i.protected ? limits.maxItemChars * 2 : limits.maxItemChars);

  const constraints = items
    .filter(
      (i) =>
        live(i) &&
        i.category === 'permanent' &&
        (i.kind === 'constraint' || (i.kind === 'policy' && i.protected)),
    )
    .sort(byOrder)
    .map(cap);
  const decisions = items
    .filter((i) => live(i) && i.category === 'decision')
    .sort(byOrder)
    .map(cap);
  const pendingTasks = items
    .filter((i) => live(i) && i.category === 'active_work' && i.kind === 'task')
    .sort((a, b) => Number(Boolean(b.deadline)) - Number(Boolean(a.deadline)) || recentFirst(a, b))
    .map(cap);
  const openQuestions = items
    .filter((i) => live(i) && i.category === 'open_question')
    .sort(recentFirst)
    .map(cap);
  const allProgress = items.filter((i) => live(i) && i.kind === 'completed').sort(recentFirst);
  const allKnowledge = items
    .filter((i) => live(i) && i.category === 'permanent' && !constraints.some((c) => c.id === i.id))
    .sort((a, b) => b.confidence - a.confidence || recentFirst(a, b));
  // Protected knowledge (deadlines, conflicts) is pinned; only unprotected knowledge is limited/trimmed.
  const pinnedKnowledge = allKnowledge.filter((i) => i.protected).map(cap);
  const extraKnowledge = allKnowledge
    .filter((i) => !i.protected)
    .slice(0, Math.max(0, limits.knowledge - pinnedKnowledge.length))
    .map(cap);
  const retainedForResources = [
    ...constraints,
    ...decisions,
    ...pendingTasks,
    ...openQuestions,
    ...allProgress,
    ...allKnowledge,
  ];
  const resources = collectResources(retainedForResources, items, limits.resources);

  // Uncertainties: never hide what GCM could not know.
  const completeness = combineCompleteness([
    ...input.imports.map((i) => i.completeness),
    ...(input.previous ? [input.previous.source.completeness] : []),
  ]);
  const quarantined = items.filter((i) => i.flags.includes('injection_suspect')).length;
  const redacted = items.filter((i) => i.flags.includes('secret_redacted')).length;
  const uncertainties: string[] = [];
  if (completeness !== 'complete') {
    uncertainties.push(
      `Source coverage is ${completeness}: this checkpoint only reflects material imported into GCM; Grok Bot may hold earlier context that is not represented here.`,
    );
  }
  if (!objective) uncertainties.push('No current objective was stated in the supplied material.');
  else if (objective.basis === 'inferred_latest_request')
    uncertainties.push(
      'The objective was inferred from the latest request; confirm it with the user.',
    );
  if (conflicts.length)
    uncertainties.push(`${conflicts.length} pair(s) of conflicting statements need confirmation.`);
  if (quarantined)
    uncertainties.push(
      `${quarantined} passage(s) resembling instruction overrides were excluded from working context; review them in the archive.`,
    );
  if (redacted)
    uncertainties.push(`${redacted} item(s) contained secret-like values that were redacted.`);
  const truncated = [...constraints, ...decisions, ...pendingTasks, ...openQuestions].filter((i) =>
    i.flags.includes('truncated'),
  );
  if (truncated.length)
    uncertainties.push(
      `${truncated.length} long item(s) were shortened; full wording is in the archive (see source references).`,
    );

  const recommendedNextAction = chooseNextAction(pendingTasks, openQuestions);
  const progress = allProgress.slice(0, limits.progress).map(cap);

  const full: CheckpointContent = {
    identity: {
      botId: input.bot.id,
      name: input.bot.name,
      role: input.bot.role,
      profileHash: botProfileHash(input.bot),
      source: 'user_provided',
      standingRules: [...new Set([...input.bot.securityBoundaries, ...input.bot.instructions])]
        .map((r) => redactSecrets(r).text)
        .slice(0, 40),
    },
    workstream: input.workstream ?? input.previous?.content.workstream ?? null,
    objective,
    constraints,
    decisions,
    pendingTasks,
    openQuestions,
    progress,
    knowledge: [...pinnedKnowledge, ...extraKnowledge],
    resources,
    conflicts,
    uncertainties,
    recommendedNextAction,
    narrative: null,
    excluded: {
      temporary: items.filter((i) => i.category === 'temporary').length,
      obsolete: Math.max(
        0,
        items.filter((i) => i.category === 'obsolete').length - progress.length,
      ),
      historical: items.filter(
        (i) => i.category === 'historical' && !i.flags.includes('injection_suspect'),
      ).length,
      quarantined,
      overBudget: 0,
      overBudgetItems: [],
    },
    stats: {
      sourceMessages: input.messages.length,
      sourceChars: input.messages.reduce((n, m) => n + m.content.length, 0),
      sourceTokensEstimate: input.messages.reduce((n, m) => n + countTokens(m.content, method), 0),
      unitsAnalyzed: units.length,
      duplicatesMerged: deduped.merged,
      supersessions,
    },
  };

  // 7. Fit the rendered handoff into the budget by trimming unprotected sections only.
  const fitted = fitToBudget(
    full,
    input.budgetTokens,
    {
      verificationCode: 'GCM-0000-0000',
      version: (input.previous?.version ?? 0) + 1,
      createdAt: new Date(0).toISOString(),
      completeness,
      archive: { imports: input.imports.length, messages: input.messages.length },
    },
    method,
  );
  warnings.push(...fitted.warnings);
  if (input.messages.length === 0 && !input.previous)
    warnings.push('No messages were supplied; the checkpoint is empty.');

  return {
    content: fitted.content,
    items,
    warnings,
    completeness,
    handoffPreviewTokens: fitted.tokens,
  };
}

export function botProfileHash(bot: BotProfile): string {
  return hashObject({ ...bot, createdAt: undefined, updatedAt: undefined });
}

export interface FitResult {
  content: CheckpointContent;
  tokens: number;
  overBudget: boolean;
  warnings: string[];
}

/**
 * Trim unprotected material (resources → oldest progress → lowest-priority knowledge) until the rendered
 * handoff fits `budget`. Protected items are never removed; if they alone exceed the budget a warning says so.
 */
export function fitToBudget(
  content: CheckpointContent,
  budget: number,
  meta: HandoffMeta,
  method: TokenMethod,
): FitResult {
  let resources = [...content.resources];
  let progress = [...content.progress];
  let knowledge = [...content.knowledge];
  const droppedItems: ContextItem[] = [];
  let droppedResources = 0;
  const build = (): CheckpointContent => ({
    ...content,
    resources,
    progress,
    knowledge,
    excluded: {
      ...content.excluded,
      overBudget: content.excluded.overBudget + droppedItems.length + droppedResources,
      overBudgetItems: [...content.excluded.overBudgetItems, ...droppedItems],
    },
  });
  let current = build();
  let tokens = countTokens(renderHandoff(current, meta), method);
  while (tokens > budget) {
    const step = Math.max(1, Math.floor((tokens - budget) / 60));
    if (resources.length > 0) {
      const n = Math.min(step, resources.length);
      resources = resources.slice(0, resources.length - n);
      droppedResources += n;
    } else if (progress.length > 0) {
      const n = Math.min(step, progress.length);
      droppedItems.push(...progress.slice(progress.length - n));
      progress = progress.slice(0, progress.length - n);
    } else {
      let idx = -1;
      for (let i = knowledge.length - 1; i >= 0; i--)
        if (!knowledge[i]!.protected) {
          idx = i;
          break;
        }
      if (idx < 0) break;
      droppedItems.push(knowledge[idx]!);
      knowledge = knowledge.filter((_, i) => i !== idx);
    }
    current = build();
    tokens = countTokens(renderHandoff(current, meta), method);
  }
  const warnings: string[] = [];
  if (tokens > budget) {
    warnings.push(
      `Protected content needs ~${tokens} tokens, above the ${budget}-token budget. Nothing protected was dropped; consider the "detailed" profile, a larger budget, or splitting work into workstreams.`,
    );
  }
  if (droppedItems.length || droppedResources) {
    warnings.push(
      `${droppedItems.length} lower-priority item(s) and ${droppedResources} resource reference(s) were left out to fit the ${budget}-token budget (listed in the checkpoint's excluded section).`,
    );
  }
  return { content: current, tokens, overBudget: tokens > budget, warnings };
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

function makeItem(
  text: string,
  cls: Classification,
  refs: SourceRef[],
  order: number,
): ContextItem {
  const { text: clean, found } = redactSecrets(text);
  const flags = [...cls.flags];
  if (found.length && !flags.includes('secret_redacted')) flags.push('secret_redacted');
  const item: ContextItem = {
    id: `it_${sha256(`${cls.category}|${dedupeKey(clean)}`).slice(0, 12)}`,
    category: cls.category,
    kind: cls.kind,
    text: clean,
    flags,
    identifiers: extractIdentifiers(clean)
      .filter((x) => x.type !== 'date' && !x.value.includes('REDACTED'))
      .map((x) => x.value)
      .slice(0, 20),
    sourceRefs: refs,
    confidence: cls.confidence,
    reason: cls.reason,
    protected: cls.protected,
    order,
  };
  if (cls.deadline) item.deadline = cls.deadline;
  return item;
}

function capText(item: ContextItem, maxChars: number): ContextItem {
  const { text, truncated } = truncateText(item.text, maxChars);
  if (!truncated) return item;
  return {
    ...item,
    text,
    flags: item.flags.includes('truncated') ? item.flags : [...item.flags, 'truncated'],
  };
}

function carryForward(prev: CheckpointRecord): ContextItem[] {
  const c = prev.content;
  const carried = [
    ...c.constraints,
    ...c.decisions,
    ...c.pendingTasks,
    ...c.openQuestions,
    ...c.knowledge,
    ...c.progress,
  ];
  return carried.map((it, idx) => ({
    ...it,
    flags: it.flags.includes('carried_forward')
      ? it.flags
      : [...it.flags, 'carried_forward' as const],
    // Older than everything new, original relative order preserved.
    order: -1_000_000 + idx,
  }));
}

/** "Yes, go with option B" after an assistant proposal turns that proposal into an evidenced decision. */
function approvedProposals(messages: StoredMessage[], units: Unit[]): ContextItem[] {
  const out: ContextItem[] = [];
  messages.forEach((msg, i) => {
    if (msg.role !== 'user' || wordCount(msg.content) > 20 || !AFFIRMATION.test(msg.content.trim()))
      return;
    const prev = messages[i - 1];
    if (!prev || prev.role !== 'assistant') return;
    const prevUnits = units.filter((u) => u.msgIndex === i - 1 && !u.isCode);
    const opt = /\boption\s+([a-z0-9])\b/i.exec(msg.content)?.[1];
    let chosen = opt
      ? prevUnits.filter((u) => new RegExp(String.raw`\boption\s+${opt}\b`, 'i').test(u.text))
      : prevUnits.filter((u) => PROPOSAL_SENTENCE.test(u.text) && !u.text.trim().endsWith('?'));
    if (chosen.length === 0 && !opt)
      chosen = prevUnits.filter((u) => /\b(?:recommend|suggest|propose)\b/i.test(u.text));
    const userRef: SourceRef = { importId: msg.importId, seq: msg.seq, role: 'user' };
    for (const u of chosen.slice(0, 2)) {
      out.push(
        makeItem(
          u.text,
          {
            category: 'decision',
            kind: 'decision',
            confidence: 0.8,
            reason: `assistant proposal approved by the user (message ${msg.seq})`,
            flags: ['approved_proposal'],
            protected: true,
          },
          [u.ref, userRef],
          u.order + 0.5,
        ),
      );
    }
  });
  return out;
}

function mergeRefs(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of [...a, ...b]) {
    const k = `${r.importId}#${r.seq}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(-MAX_REFS_PER_ITEM);
}

function mergeInto(target: ContextItem, other: ContextItem): void {
  if (other.order > target.order) {
    target.text = other.text;
    target.order = other.order;
    if (other.deadline) target.deadline = other.deadline;
  }
  target.sourceRefs = mergeRefs(target.sourceRefs, other.sourceRefs);
  for (const f of other.flags) if (!target.flags.includes(f)) target.flags.push(f);
  target.identifiers = [...new Set([...target.identifiers, ...other.identifiers])].slice(0, 20);
  target.confidence = Math.max(target.confidence, other.confidence);
  target.protected = target.protected || other.protected;
}

function dedupe(items: ContextItem[]): { items: ContextItem[]; merged: number } {
  let merged = 0;
  const byId = new Map<string, ContextItem>();
  const out: ContextItem[] = [];
  for (const it of [...items].sort((a, b) => a.order - b.order)) {
    if (!dedupeKey(it.text)) {
      merged++;
      continue;
    }
    const existing = byId.get(it.id);
    if (existing) {
      mergeInto(existing, it);
      merged++;
    } else {
      const copy = {
        ...it,
        flags: [...it.flags],
        sourceRefs: [...it.sourceRefs],
        identifiers: [...it.identifiers],
      };
      byId.set(it.id, copy);
      out.push(copy);
    }
  }
  // Near-duplicates within the same working-context category.
  const working = out.filter((i) => !['temporary', 'historical'].includes(i.category));
  const words = new Map(working.map((i) => [i.id, contentWords(i.text)]));
  const removed = new Set<string>();
  const index = new Map<string, ContextItem[]>();
  for (const it of working) {
    const w = words.get(it.id)!;
    if (w.size < 3) continue;
    const candidates = new Set<ContextItem>();
    for (const word of w) for (const other of index.get(word) ?? []) candidates.add(other);
    for (const other of candidates) {
      if (removed.has(other.id) || other.category !== it.category || other.kind !== it.kind)
        continue;
      if (jaccard(w, words.get(other.id)!) >= 0.8 && !valuesDiffer(other.text, it.text)) {
        mergeInto(it, other);
        removed.add(other.id);
        merged++;
      }
    }
    for (const word of w) {
      const list = index.get(word) ?? [];
      list.push(it);
      index.set(word, list);
    }
  }
  return { items: out.filter((i) => !removed.has(i.id)), merged };
}

// ---------------------------------------------------------------------------------------------
// Supersession and conflicts
// ---------------------------------------------------------------------------------------------

const TIME_WORDS = 'next this week today tomorrow tonight later soon asap';
const TASK_STOP = new Set(
  `todo to-do need needs task tasks action item step steps still remaining pending follow up will going plan please make sure finish complete get start ${TIME_WORDS}`.split(
    ' ',
  ),
);
/** Generic completion words only; specific verbs ("scheduled", "sent") stay so they match their task ("schedule", "send"). */
const DONE_STOP = new Set(
  `done completed complete finished just already successfully now wrapped ${TIME_WORDS}`.split(' '),
);
const DECISION_STOP = new Set(
  'decided decide decision agreed agree going go use using will plan chose chosen settled opted final approved update correction actually instead rather switch switched changed change no longer now'.split(
    ' ',
  ),
);
const STRONG_SUPERSEDE =
  /\b(?:instead of|rather than|switch(?:ed|ing)? (?:from|to)|replac(?:e|es|ed|ing)|no longer|scratch that|changed? (?:it |this |that )?(?:from|to)|revert(?:ed|ing)? to|supersed(?:e|es|ed)|overrid(?:e|es|ing|den)|correction)\b/i;
const WEAK_SUPERSEDE =
  /\b(?:update:|updated?:|is now|are now|now (?:is|are|uses|use)|actually,|revised|postponed|rescheduled|pushed (?:back|to)|moved (?:from|to))\b/i;
const NEG_POLARITY = /\b(?:not|never|no|don't|do not|must not|shouldn't|avoid|without)\b/i;

const stemCache = new Map<string, Set<string>>();
function subjectWords(text: string, stop: Set<string>): Set<string> {
  const key = `${text}\u0000${stop.size}`;
  let v = stemCache.get(key);
  if (!v) {
    v = contentWords(text, stop);
    if (stemCache.size > 20_000) stemCache.clear();
    stemCache.set(key, v);
  }
  return v;
}

function valueTokens(text: string): Set<string> {
  const vals = new Set<string>();
  for (const m of text.match(/(?:[$€£¥₹]\s?)?\d[\d,.]*(?:\s?[kKmM%])?/g) ?? [])
    vals.add(m.replace(/[\s,]/g, '').toLowerCase());
  for (const m of text.match(DATE_RE) ?? []) vals.add(m.toLowerCase());
  return vals;
}

export function valuesDiffer(a: string, b: string): boolean {
  if (NEG_POLARITY.test(a) !== NEG_POLARITY.test(b)) return true;
  const va = valueTokens(a);
  const vb = valueTokens(b);
  if (va.size === 0 || vb.size === 0) return false;
  const aOnly = [...va].some((x) => !vb.has(x));
  const bOnly = [...vb].some((x) => !va.has(x));
  return aOnly && bOnly;
}

function shared(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x));
}

function resolveSupersession(items: ContextItem[]): {
  conflicts: Conflict[];
  supersessions: number;
} {
  let supersessions = 0;
  const conflicts: Conflict[] = [];
  const supersede = (old: ContextItem, by: ContextItem, why: string) => {
    old.supersededBy = by.id;
    old.category = 'obsolete';
    old.kind = 'superseded';
    old.protected = false;
    old.reason = `${old.reason}; ${why}`;
    supersessions++;
  };

  // Tasks closed by later completion statements.
  const tasks = items.filter((i) => i.category === 'active_work' && i.kind === 'task');
  const completions = items.filter((i) => i.kind === 'completed');
  for (const t of tasks) {
    const tw = subjectWords(t.text, TASK_STOP);
    for (const done of completions) {
      if (done.order <= t.order) continue;
      const dw = subjectWords(done.text, DONE_STOP);
      const common = shared(tw, dw);
      const sharedId = t.identifiers.some((x) => done.identifiers.includes(x));
      if ((common.length >= 2 && overlap(tw, dw) >= 0.6) || (sharedId && common.length >= 1)) {
        supersede(
          t,
          done,
          `completed later (message ${done.sourceRefs[done.sourceRefs.length - 1]?.seq ?? '?'})`,
        );
        break;
      }
    }
  }

  // Decisions / constraints / knowledge: explicit change markers supersede, otherwise differing values conflict.
  const families: ContextItem['kind'][][] = [
    ['decision'],
    ['constraint', 'policy'],
    ['fact', 'preference'],
  ];
  for (const kinds of families) {
    const list = items
      .filter((i) => kinds.includes(i.kind) && !i.supersededBy)
      .sort((a, b) => a.order - b.order);
    for (let j = 1; j < list.length; j++) {
      const later = list[j]!;
      const lw = subjectWords(later.text, DECISION_STOP);
      for (let i = 0; i < j; i++) {
        const earlier = list[i]!;
        if (earlier.supersededBy) continue;
        const ew = subjectWords(earlier.text, DECISION_STOP);
        const common = shared(ew, lw).filter((w) => w.length >= 3);
        if (common.length === 0) continue;
        const sim = jaccard(ew, lw);
        const ov = overlap(ew, lw);
        if (
          STRONG_SUPERSEDE.test(later.text) &&
          common.some((w) => w.length >= 4) &&
          (ov >= 0.3 || common.length >= 2)
        ) {
          supersede(
            earlier,
            later,
            `superseded by a later explicit change (message ${later.sourceRefs[0]?.seq ?? '?'})`,
          );
        } else if (WEAK_SUPERSEDE.test(later.text) && common.length >= 2 && ov >= 0.5) {
          supersede(
            earlier,
            later,
            `superseded by a later update (message ${later.sourceRefs[0]?.seq ?? '?'})`,
          );
        } else if (
          (sim >= 0.4 || (common.length >= 3 && ov >= 0.6)) &&
          valuesDiffer(earlier.text, later.text)
        ) {
          for (const it of [earlier, later]) {
            if (!it.flags.includes('conflict')) it.flags.push('conflict');
            it.protected = true;
          }
          conflicts.push({
            id: `cf_${sha256(earlier.id + later.id).slice(0, 10)}`,
            itemIds: [earlier.id, later.id],
            texts: [earlier.text, later.text],
            reason:
              'Similar statements with different values or opposite polarity and no explicit change marker.',
          });
        }
      }
    }
  }
  return { conflicts, supersessions };
}

// ---------------------------------------------------------------------------------------------
// Objective, next action, resources
// ---------------------------------------------------------------------------------------------

function chooseObjective(
  input: CompactInput,
  items: ContextItem[],
): CheckpointContent['objective'] {
  if (input.objective?.trim())
    return { text: input.objective.trim(), basis: 'user_supplied', sourceRefs: [] };
  const explicit = items
    .filter(
      (i) =>
        i.kind === 'objective' &&
        !i.flags.includes('carried_forward') &&
        !i.flags.includes('injection_suspect'),
    )
    .sort((a, b) => b.order - a.order)[0];
  if (explicit)
    return {
      text: truncateText(explicit.text, 600).text,
      basis: 'explicit',
      sourceRefs: explicit.sourceRefs,
    };
  const prev = input.previous?.content.objective;
  if (prev)
    return { ...prev, basis: prev.basis === 'user_supplied' ? 'user_supplied' : 'carried_forward' };
  const latest = items
    .filter(
      (i) =>
        i.kind === 'task' &&
        i.reason.includes('latest unanswered request') &&
        wordCount(i.text) >= 5,
    )
    .sort((a, b) => a.order - b.order)[0];
  if (latest)
    return {
      text: truncateText(latest.text, 400).text,
      basis: 'inferred_latest_request',
      sourceRefs: latest.sourceRefs,
    };
  return null;
}

function chooseNextAction(
  tasks: ContextItem[],
  questions: ContextItem[],
): CheckpointContent['recommendedNextAction'] {
  const blocker = questions.find((q) => q.kind === 'blocker');
  if (blocker) {
    return {
      text: `Resolve blocker: ${blocker.text}`,
      basis: 'most recent open blocker',
      sourceRefs: blocker.sourceRefs,
    };
  }
  const task = tasks[0];
  if (task) {
    return {
      text: task.text,
      basis: task.deadline
        ? `pending task with deadline (${task.deadline})`
        : 'most recent pending task',
      sourceRefs: task.sourceRefs,
    };
  }
  return null;
}

const RESOURCE_PRIORITY: Resource['type'][] = [
  'file',
  'url',
  'ticket',
  'env',
  'email',
  'version',
  'identifier',
];

function collectResources(retained: ContextItem[], all: ContextItem[], limit: number): Resource[] {
  const map = new Map<string, Resource & { count: number; last: number }>();
  const consider = [
    ...retained,
    ...all.filter((i) => i.category === 'historical' && !i.flags.includes('injection_suspect')),
  ];
  for (const it of consider) {
    for (const id of extractIdentifiers(it.text)) {
      if (!RESOURCE_PRIORITY.includes(id.type) || id.value.includes('REDACTED')) continue;
      const existing = map.get(id.value);
      if (existing) {
        existing.count++;
        existing.last = Math.max(existing.last, it.order);
        existing.sourceRefs = mergeRefs(existing.sourceRefs, it.sourceRefs).slice(-3);
      } else {
        map.set(id.value, {
          value: id.value,
          type: id.type,
          sourceRefs: it.sourceRefs.slice(-3),
          count: 1,
          last: it.order,
        });
      }
    }
  }
  return [...map.values()]
    .sort(
      (a, b) =>
        RESOURCE_PRIORITY.indexOf(a.type) - RESOURCE_PRIORITY.indexOf(b.type) ||
        b.count - a.count ||
        b.last - a.last,
    )
    .slice(0, limit)
    .map(({ value, type, sourceRefs }) => ({ value, type, sourceRefs }));
}
