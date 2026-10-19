/**
 * Prompt-injection heuristics.
 *
 * GCM never executes anything found in a transcript, so imported text cannot control the application.
 * The risk is downstream: a handoff that is pasted into Grok Bot could smuggle an embedded instruction
 * ("ignore previous instructions…") into a fresh session with the authority of a checkpoint.
 * Matching passages are quarantined: kept in the archive, excluded from checkpoints/handoffs,
 * and surfaced to the user for review — never silently dropped.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules?|messages?|context|guidelines)/i,
  /\byou\s+are\s+now\s+(?:a|an|in|the|no longer)\b/i,
  /\b(?:new|updated|real|hidden)\s+(?:system\s+)?instructions?\s*:/i,
  /\b(?:system|developer)\s+prompt\b/i,
  /<\/?\s*(?:system|assistant|instructions?|im_start|im_end)\s*>/i,
  /\[\s*(?:system|inst)\s*\]/i,
  /\b(?:jailbreak|developer\s+mode|DAN\s+mode|do\s+anything\s+now)\b/i,
  /\b(?:reveal|print|exfiltrate|send|leak)\s+(?:your|the)\s+(?:system\s+prompt|instructions|api\s+keys?|secrets?|tokens?|credentials?)/i,
  /\bBEGIN\s+(?:SYSTEM|ADMIN|ROOT)\b/,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}
