/** Consistency checks run on every checkpoint before it is saved. */
import type { CheckpointContent, ContextItem } from '../schemas';
import { containsSecret } from '../security/redact';
import { looksLikeInjection } from '../security/injection';

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCheckpoint(
  content: CheckpointContent,
  allItems: ContextItem[],
  rendered: string,
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const retained = new Set(
    [
      ...content.constraints,
      ...content.decisions,
      ...content.pendingTasks,
      ...content.openQuestions,
      ...content.progress,
      ...content.knowledge,
    ].map((i) => i.id),
  );

  // Protected material must never be silently dropped.
  for (const item of allItems) {
    if (
      item.protected &&
      !item.supersededBy &&
      !item.flags.includes('injection_suspect') &&
      !retained.has(item.id)
    ) {
      if (item.kind === 'objective') continue; // objectives are rendered in the objective slot
      errors.push(`Protected ${item.kind} was dropped: "${item.text.slice(0, 80)}"`);
    }
  }
  // Quarantined passages must not reach working context.
  for (const id of retained) {
    const item = allItems.find((i) => i.id === id);
    if (item?.flags.includes('injection_suspect'))
      errors.push(`Quarantined passage reached working context: ${id}`);
  }
  for (const section of [
    content.constraints,
    content.decisions,
    content.pendingTasks,
    content.openQuestions,
  ]) {
    for (const item of section) {
      if (looksLikeInjection(item.text))
        errors.push(`Instruction-override text in working context: "${item.text.slice(0, 60)}"`);
    }
  }
  if (containsSecret(rendered)) errors.push('Rendered handoff still contains a secret-like value.');
  // Conflicts must reference retained items.
  for (const cf of content.conflicts) {
    for (const id of cf.itemIds)
      if (!retained.has(id))
        warnings.push(`Conflict ${cf.id} references an item that is not retained.`);
  }
  if (content.objective === null && content.pendingTasks.length === 0) {
    warnings.push('Checkpoint has no objective and no pending tasks.');
  }
  return { ok: errors.length === 0, errors, warnings };
}
