/**
 * Exact-identifier extraction. Identifiers (paths, URLs, ticket IDs, env vars, versions, amounts,
 * dates) are copied verbatim into checkpoints so that compaction never paraphrases them away.
 */
import type { Resource } from '../schemas';

type ResourceType = Resource['type'];

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|html|htm|css|scss|less|yaml|yml|toml|ini|env|sql|sh|ps1|psm1|bat|cmd|txt|csv|tsv|xlsx|xls|docx|doc|pdf|pptx|ppt|key|png|jpg|jpeg|svg|gif|webp|mp4|mov|zip|lock|xml|vue|svelte|swift|dart|tf|ipynb|log';

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS =
  'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';

export const DATE_RE = new RegExp(
  String.raw`\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}/\d{1,2}/\d{2,4}|(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})(?:\s+\d{4})?|(?:next\s+|this\s+)?(?:${WEEKDAYS})|tomorrow|tonight|next\s+(?:week|month|quarter|sprint)|end\s+of\s+(?:day|week|month|quarter|year|sprint)|eod|eow|eom|eoq|q[1-4](?:\s+\d{4})?)\b`,
  'gi',
);

const DEADLINE_RE = new RegExp(
  String.raw`\b(?:by|before|due(?:\s+(?:by|on|date))?|deadline(?:\s+is)?|until|no\s+later\s+than|ahead\s+of|launch(?:es|ing)?\s+on|ship(?:s|ping)?\s+on)\s*:?\s*(?<when>${DATE_RE.source})`,
  'i',
);
const DEADLINE_LABEL_RE = /\bdeadline\s*[:\-–]\s*(?<when>[^.;\n]{2,40})/i;

const PATTERNS: { type: ResourceType; re: RegExp }[] = [
  { type: 'url', re: /\bhttps?:\/\/[^\s<>"'`)\]]+/g },
  { type: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi },
  { type: 'file', re: /\b[A-Za-z]:\\(?:[^\\\s"'<>|:*?]+\\)*[^\\\s"'<>|:*?,;]+/g },
  { type: 'file', re: /(?<![\w:/.])(?:~|\.{1,2})?\/(?:[\w@.-]+\/)+[\w@.-]+/g },
  {
    type: 'file',
    re: new RegExp(String.raw`(?<![\w/\\.@-])(?:[\w@-]+[/\\])*[\w@.-]+\.(?:${FILE_EXT})\b`, 'g'),
  },
  { type: 'ticket', re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g },
  { type: 'ticket', re: /(?<![\w&])#\d{1,6}\b/g },
  { type: 'env', re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g },
  { type: 'version', re: /\bv\d+(?:\.\d+){1,3}(?:-[\w.]+)?\b|\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/g },
  {
    type: 'amount',
    re: /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|dollars|euros)\b|\b\d+(?:\.\d+)?\s?%)/g,
  },
  { type: 'identifier', re: /`([^`\n]{2,80})`/g },
];

export interface ExtractedIdentifier {
  value: string;
  type: ResourceType;
}

export function extractIdentifiers(text: string): ExtractedIdentifier[] {
  const seen = new Set<string>();
  const out: ExtractedIdentifier[] = [];
  const add = (value: string, type: ResourceType) => {
    const v = value.replace(/[.,;:!?]+$/, '').trim();
    if (v.length < 2 || seen.has(v)) return;
    // A URL or path already captured makes its sub-matches redundant.
    for (const prev of seen)
      if (prev.includes(v) && prev !== v && (type === 'file' || type === 'ticket')) return;
    seen.add(v);
    out.push({ value: v, type });
  };
  const urls = text.match(PATTERNS[0]!.re) ?? [];
  // Strip URLs before path/file matching so URL fragments aren't re-reported as files.
  const withoutUrls = urls.reduce((t, u) => t.replace(u, ' '), text);
  for (const u of urls) add(u, 'url');
  for (const { type, re } of PATTERNS.slice(1)) {
    const source = type === 'email' ? text : withoutUrls;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      add(type === 'identifier' ? (m[1] ?? m[0]) : m[0], type);
    }
  }
  for (const d of text.match(DATE_RE) ?? []) {
    if (/^\d{4}-\d{2}-\d{2}/.test(d) || /\d/.test(d)) add(d, 'date');
  }
  return out;
}

export function extractDeadline(text: string): string | undefined {
  const m = DEADLINE_RE.exec(text) ?? DEADLINE_LABEL_RE.exec(text);
  return m?.groups?.when?.trim();
}
