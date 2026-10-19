/** Text normalization and similarity helpers used by the compaction engine. */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
// C0 control chars except \t \n \r
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeWhitespace(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at for from by with without as is are was were be been being ' +
    'it its this that these those there here we our ours us you your yours i me my mine he she they them their ' +
    'will would should could can may might must shall do does did done doing have has had having not no yes ' +
    'so than too very just also only about into over under again further once all any both each few more most ' +
    'other some such own same what which who whom when where why how up down out off now please ok okay let lets'
  ).split(' '),
);

/** Lowercased word tokens (letters/digits, keeps identifiers like v1.2 or ABC-123 intact-ish). */
export function words(text: string): string[] {
  return (
    text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.\-/]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []
  );
}

export function contentWords(text: string, extraStop?: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    if (STOPWORDS.has(w) || extraStop?.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** Very small suffix stripper so "sent"/"send", "drafting"/"draft" line up. Deliberately conservative. */
const IRREGULAR: Record<string, string> = {
  sent: 'send',
  paid: 'pay',
  wrote: 'write',
  written: 'write',
  made: 'make',
  built: 'build',
  bought: 'buy',
  met: 'meet',
  told: 'tell',
  ran: 'run',
  took: 'take',
  taken: 'take',
  gave: 'give',
  given: 'give',
  got: 'get',
  did: 'do',
  chose: 'choose',
  chosen: 'choose',
  drew: 'draw',
  drawn: 'draw',
  began: 'begin',
  begun: 'begin',
};

function stem(w: string): string {
  const irregular = IRREGULAR[w];
  if (irregular) return irregular;
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w
    .replace(/(ing|ed|es|s)$/u, '')
    .replace(/(ation|ment)$/u, '')
    .replace(/e$/u, '');
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|). Better than Jaccard when one side is a short reference. */
export function overlap(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / min;
}

/** Key used for exact de-duplication: case/punctuation/label insensitive. */
export function dedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX✓]\]\s*/, '')
    .replace(
      /^\s*(?:todo|to-do|decision|action(?: item)?|next(?: steps?)?|note|update|done|blocker|question|constraint|rule|fyi|remember|reminder|important|please note)\s*[:\-–]\s*/i,
      '',
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const ABBREVIATIONS =
  /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|approx|inc|ltd|no|fig|est|dept|jr|sr)\.$/i;

/**
 * Split prose into sentences without breaking file names (`app.ts`), versions (`v1.2`),
 * URLs, or common abbreviations.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?]+["')\]]*\s+(?=["'([]?[A-Z0-9\p{Lu}])/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].trimEnd().length;
    const candidate = text.slice(last, end);
    if (ABBREVIATIONS.test(candidate.trimEnd())) continue;
    out.push(candidate.trim());
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.length > 0);
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '), slice.lastIndexOf(', '));
  const base = cut > maxChars * 0.6 ? slice.slice(0, cut + 1) : slice.replace(/\s+\S*$/, '');
  return { text: `${base.trimEnd()} …`, truncated: true };
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}
