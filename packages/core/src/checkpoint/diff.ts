/** Section-by-section comparison of two checkpoints. */
import type { CheckpointContent, CheckpointRecord, ContextItem } from '../schemas';
import { dedupeKey } from '../util/text';

export const DIFF_SECTIONS = [
  'constraints',
  'decisions',
  'pendingTasks',
  'openQuestions',
  'progress',
  'knowledge',
] as const;
export type DiffSection = (typeof DIFF_SECTIONS)[number];

export interface SectionDiff {
  added: string[];
  removed: string[];
  changed: { before: string; after: string }[];
  unchanged: number;
}

export interface CheckpointDiff {
  from: { id: string; version: number; createdAt: string };
  to: { id: string; version: number; createdAt: string };
  objective: { before: string | null; after: string | null; changed: boolean };
  sections: Record<DiffSection, SectionDiff>;
  resources: { added: string[]; removed: string[] };
  conflicts: { before: number; after: number };
  tokens: { before: number; after: number };
  summary: string;
}

function diffItems(a: ContextItem[], b: ContextItem[]): SectionDiff {
  const result: SectionDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  const matched = new Set<ContextItem>();
  const bById = new Map(b.map((i) => [i.id, i]));
  const bByKey = new Map(b.map((i) => [dedupeKey(i.text), i]));
  for (const item of a) {
    const other = bById.get(item.id) ?? bByKey.get(dedupeKey(item.text));
    if (!other || matched.has(other)) {
      result.removed.push(item.text);
      continue;
    }
    matched.add(other);
    if (other.text === item.text) result.unchanged++;
    else result.changed.push({ before: item.text, after: other.text });
  }
  for (const item of b) if (!matched.has(item)) result.added.push(item.text);
  return result;
}

export function diffCheckpoints(from: CheckpointRecord, to: CheckpointRecord): CheckpointDiff {
  const a: CheckpointContent = from.content;
  const b: CheckpointContent = to.content;
  const sections = Object.fromEntries(
    DIFF_SECTIONS.map((s) => [s, diffItems(a[s], b[s])]),
  ) as Record<DiffSection, SectionDiff>;
  const ra = new Set(a.resources.map((r) => r.value));
  const rb = new Set(b.resources.map((r) => r.value));
  const objBefore = a.objective?.text ?? null;
  const objAfter = b.objective?.text ?? null;
  const parts: string[] = [];
  for (const s of DIFF_SECTIONS) {
    const d = sections[s];
    if (d.added.length || d.removed.length || d.changed.length) {
      parts.push(`${s}: +${d.added.length} −${d.removed.length} ~${d.changed.length}`);
    }
  }
  if (objBefore !== objAfter) parts.unshift('objective changed');
  return {
    from: { id: from.id, version: from.version, createdAt: from.createdAt },
    to: { id: to.id, version: to.version, createdAt: to.createdAt },
    objective: { before: objBefore, after: objAfter, changed: objBefore !== objAfter },
    sections,
    resources: {
      added: [...rb].filter((x) => !ra.has(x)),
      removed: [...ra].filter((x) => !rb.has(x)),
    },
    conflicts: { before: a.conflicts.length, after: b.conflicts.length },
    tokens: { before: from.tokenEstimate.tokens, after: to.tokenEstimate.tokens },
    summary: parts.length ? parts.join('; ') : 'No content differences.',
  };
}
