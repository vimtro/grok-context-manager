/**
 * Conversation import adapters.
 *
 * Grok Bot has no documented transcript export, so GCM accepts what users can actually obtain:
 * copied chat text, Markdown notes, or JSON / JSONL message lists (from other tools or scripts).
 * Parsing is purely structural: content is treated as data and never interpreted as instructions.
 */
import type { ParsedMessage, Role, SourceFormat } from '../schemas';
import { normalizeWhitespace } from '../util/text';

export interface ParseResult {
  format: Exclude<SourceFormat, 'auto'>;
  messages: ParsedMessage[];
  warnings: string[];
  /** True when the material itself suggests it is not the full conversation. */
  truncationSuspected: boolean;
}

export const MAX_MESSAGES_PER_IMPORT = 100_000;

export interface ParseOptions {
  /** Speaker names that are the bot (e.g. the bot profile's name and id). */
  assistantNames?: string[];
  /** Speaker names that are the human user. */
  userNames?: string[];
}

const USER_ALIASES = new Set([
  'user',
  'you',
  'me',
  'human',
  'customer',
  'client',
  'owner',
  'operator',
]);
const ASSISTANT_ALIASES = new Set([
  'assistant',
  'ai',
  'bot',
  'grok',
  'grok bot',
  'model',
  'agent',
  'claude',
  'gpt',
]);
const SYSTEM_ALIASES = new Set(['system', 'developer']);
const TOOL_ALIASES = new Set(['tool', 'function', 'tool result', 'tool output']);

/** Words that look like `Word:` speaker labels but are almost always inline labels. */
const LABEL_WORDS = new Set(
  (
    'note notes todo to-do decision decisions action actions next update done blocker blockers question questions ' +
    'constraint constraints rule rules fyi objective goal goals deadline step steps example warning error errors re ' +
    'subject date time status owner http https summary tip important reminder answer result output input task tasks ' +
    'context background reason problem solution fix file files path url link email phone address total cost price ' +
    'budget priority p0 p1 p2 tl;dr tldr pros cons option options plan approach issue issues risk risks'
  ).split(' '),
);

const TS = String.raw`\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[ ,T]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?`;
const SPEAKER_LINE = new RegExp(
  String.raw`^(?:\[(?<ts1>${TS})\]\s*[-–]?\s*|(?<ts0>${TS})\s*[-–]\s*)?(?:\*\*|__)?(?<name>[A-Za-z][\w .'&-]{0,40}?)(?:\*\*|__)?\s*(?:[([](?<ts2>${TS})[)\]])?\s*(?:\*\*|__)?\s*[:：](?:\*\*|__)?(?:\s+(?<rest>.*))?$`,
);
const HEADING_SPEAKER = new RegExp(
  String.raw`^#{1,6}\s+(?:\[(?<ts1>${TS})\]\s*)?(?<name>[A-Za-z][\w .'&-]{0,40}?)\s*(?:[([—–-]\s*(?<ts2>${TS})\s*[)\]]?)?\s*:?\s*$`,
);

const TRUNCATION_MARKERS =
  /\[(?:truncated|\.{3}\s*truncated|message truncated)\]|\(truncated\)|earlier messages (?:hidden|omitted|not shown)|(?:show|load) (?:more|earlier) messages|conversation truncated|… ?\(\d+ more\)/i;

export function mapRole(name: string): Role {
  const n = name.trim().toLowerCase();
  if (USER_ALIASES.has(n)) return 'user';
  if (ASSISTANT_ALIASES.has(n) || /\b(?:bot|grok|assistant|agent)\b/.test(n)) return 'assistant';
  if (SYSTEM_ALIASES.has(n)) return 'system';
  if (TOOL_ALIASES.has(n)) return 'tool';
  return 'unknown';
}

export function parseConversation(
  input: string,
  format: SourceFormat = 'auto',
  opts: ParseOptions = {},
): ParseResult {
  const text = normalizeWhitespace(input);
  const warnings: string[] = [];
  let result: ParseResult;

  const resolved = format === 'auto' ? detectFormat(text) : format;
  switch (resolved) {
    case 'json':
      result = parseJson(text, warnings);
      break;
    case 'jsonl':
      result = parseJsonl(text, warnings);
      break;
    default:
      result = parseText(text, warnings);
  }

  applySpeakerNames(result, opts);

  if (TRUNCATION_MARKERS.test(text)) {
    result.truncationSuspected = true;
    result.warnings.push(
      'The material contains truncation markers; it is not the full conversation.',
    );
  }
  if (result.messages.length > MAX_MESSAGES_PER_IMPORT) {
    result.warnings.push(
      `Import capped at ${MAX_MESSAGES_PER_IMPORT} messages; ${result.messages.length - MAX_MESSAGES_PER_IMPORT} were not imported.`,
    );
    result.messages = result.messages.slice(0, MAX_MESSAGES_PER_IMPORT);
    result.truncationSuspected = true;
  }
  return result;
}

export function detectFormat(text: string): Exclude<SourceFormat, 'auto'> {
  const t = text.trimStart();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      const lines = t.split('\n').filter((l) => l.trim());
      if (lines.length > 0 && lines.every((l) => isJsonObjectLine(l))) return 'jsonl';
    }
  }
  if (/^#{1,6}\s+\S/m.test(text)) return 'markdown';
  return 'text';
}

function isJsonObjectLine(line: string): boolean {
  const l = line.trim();
  if (!l.startsWith('{')) return false;
  try {
    const v: unknown = JSON.parse(l);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Resolve named speakers: explicit bot/user names first; then, in a two-party conversation where one side is
 * already the user, the single remaining named speaker is the assistant.
 */
function applySpeakerNames(result: ParseResult, opts: ParseOptions): void {
  const norm = (s: string) => s.trim().toLowerCase();
  const bots = new Set((opts.assistantNames ?? []).map(norm).filter(Boolean));
  const users = new Set((opts.userNames ?? []).map(norm).filter(Boolean));
  for (const m of result.messages) {
    if (!m.author) continue;
    const a = norm(m.author);
    if (bots.has(a) || bots.has(a.replace(/\s+/g, '-'))) m.role = 'assistant';
    else if (users.has(a)) m.role = 'user';
  }
  const unknownAuthors = new Set(
    result.messages.filter((m) => m.role === 'unknown' && m.author).map((m) => norm(m.author!)),
  );
  const hasUser = result.messages.some((m) => m.role === 'user');
  const hasAssistant = result.messages.some((m) => m.role === 'assistant');
  if (hasUser && !hasAssistant && unknownAuthors.size === 1) {
    const [only] = [...unknownAuthors];
    for (const m of result.messages) if (m.author && norm(m.author) === only) m.role = 'assistant';
    result.warnings.push(
      `Speaker "${only}" was treated as the bot (two-party conversation). Use --assistant-name to override.`,
    );
  } else if (unknownAuthors.size > 0) {
    result.warnings.push(
      `Speaker role unknown for: ${[...unknownAuthors].slice(0, 5).join(', ')}. Pass --assistant-name / --user-name to improve analysis.`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// JSON / JSONL
// -------------------------------------------------------------------------------------------

function parseJson(text: string, warnings: string[]): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`, { cause: e });
  }
  const list = findMessageArray(data);
  if (!list) {
    throw new Error(
      'JSON did not contain a message list. Expected an array of {role, content} objects or {"messages": [...]}.',
    );
  }
  return {
    format: 'json',
    messages: toMessages(list, warnings),
    warnings,
    truncationSuspected: false,
  };
}

function parseJsonl(text: string, warnings: string[]): ParseResult {
  const items: unknown[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      items.push(JSON.parse(line));
    } catch {
      warnings.push(`Line ${i + 1} is not valid JSON and was skipped.`);
    }
  });
  return {
    format: 'jsonl',
    messages: toMessages(items, warnings),
    warnings,
    truncationSuspected: false,
  };
}

function findMessageArray(data: unknown, depth = 0): unknown[] | null {
  if (depth > 4) return null;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of [
      'messages',
      'conversation',
      'chat',
      'transcript',
      'items',
      'turns',
      'history',
      'data',
    ]) {
      if (key in obj) {
        const found = findMessageArray(obj[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function toMessages(list: unknown[], warnings: string[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  let skipped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      if (typeof raw === 'string' && raw.trim()) out.push({ role: 'unknown', content: raw.trim() });
      else skipped++;
      continue;
    }
    const m = raw as Record<string, unknown>;
    const content = extractContent(
      m.content ?? m.text ?? m.message ?? m.body ?? m.parts ?? m.value,
    );
    if (!content) {
      skipped++;
      continue;
    }
    const speaker = extractSpeaker(
      m.role ?? m.sender ?? m.author ?? m.from ?? m.speaker ?? m.name ?? m.type,
    );
    const timestamp = extractTimestamp(
      m.timestamp ?? m.created_at ?? m.createdAt ?? m.time ?? m.date ?? m.ts ?? m.create_time,
    );
    const msg: ParsedMessage = { role: speaker.role, content: normalizeWhitespace(content) };
    if (speaker.author) msg.author = speaker.author;
    else if (typeof m.author === 'string' && m.author.trim() && m.role !== undefined)
      msg.author = m.author.trim().slice(0, 80);
    if (timestamp) msg.timestamp = timestamp;
    out.push(msg);
  }
  if (skipped > 0)
    warnings.push(
      `${skipped} entr${skipped === 1 ? 'y' : 'ies'} without text content were skipped.`,
    );
  return out;
}

function extractContent(v: unknown, depth = 0): string {
  if (depth > 5 || v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((p) => extractContent(p, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Only textual parts; images/files/binary payloads are not imported.
    if (
      typeof o.type === 'string' &&
      !['text', 'input_text', 'output_text', 'markdown'].includes(o.type)
    ) {
      return '';
    }
    return extractContent(o.text ?? o.content ?? o.parts ?? o.value, depth + 1);
  }
  return '';
}

function extractSpeaker(v: unknown): { role: Role; author?: string } {
  if (typeof v === 'string' && v.trim()) {
    const role = mapRole(v);
    return role === 'unknown' ||
      !['user', 'assistant', 'system', 'tool'].includes(v.trim().toLowerCase())
      ? { role, author: v.trim().slice(0, 80) }
      : { role };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const inner = o.role ?? o.name ?? o.type;
    if (typeof inner === 'string') return extractSpeaker(inner);
  }
  return { role: 'unknown' };
}

function extractTimestamp(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
  return undefined;
}

// -------------------------------------------------------------------------------------------
// Plain text / Markdown
// -------------------------------------------------------------------------------------------

interface SpeakerHit {
  index: number;
  name: string;
  timestamp?: string;
  rest: string;
  heading: boolean;
}

function parseText(text: string, warnings: string[]): ParseResult {
  const lines = text.split('\n');
  const hits: SpeakerHit[] = [];
  const nameCounts = new Map<string, number>();
  let inFence = false;

  lines.forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence || /^\s/.test(raw)) return;
    const h = HEADING_SPEAKER.exec(raw);
    const s = h ? null : SPEAKER_LINE.exec(raw);
    const m = h ?? s;
    if (!m?.groups?.name) return;
    const name = m.groups.name.trim();
    if (LABEL_WORDS.has(name.toLowerCase()) || name.split(/\s+/).length > 4) return;
    const ts = m.groups.ts0 ?? m.groups.ts1 ?? m.groups.ts2;
    const hit: SpeakerHit = {
      index,
      name,
      rest: (s ? m.groups.rest : '') ?? '',
      heading: Boolean(h),
    };
    if (ts) hit.timestamp = ts;
    hits.push(hit);
    nameCounts.set(name.toLowerCase(), (nameCounts.get(name.toLowerCase()) ?? 0) + 1);
  });

  // Accept a speaker name when it's a known alias or recurs (a real participant), not a one-off label.
  const accepted = hits.filter((h) => {
    const n = h.name.toLowerCase();
    return mapRole(n) !== 'unknown' || (nameCounts.get(n) ?? 0) >= 2;
  });

  const usedHeadings = accepted.some((h) => h.heading);
  if (accepted.length === 0) {
    warnings.push(
      'No speaker labels detected; the text was imported as notes (role "unknown"), one per paragraph.',
    );
    const messages = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((content): ParsedMessage => ({ role: 'unknown', content }));
    return {
      format: usedHeadings ? 'markdown' : detectFormat(text),
      messages,
      warnings,
      truncationSuspected: false,
    };
  }

  const messages: ParsedMessage[] = [];
  const preamble = lines.slice(0, accepted[0]!.index).join('\n').trim();
  if (preamble) messages.push({ role: 'unknown', content: preamble });

  accepted.forEach((hit, i) => {
    const end = i + 1 < accepted.length ? accepted[i + 1]!.index : lines.length;
    const body = [hit.rest, ...lines.slice(hit.index + 1, end)].join('\n').trim();
    if (!body) return;
    const role = mapRole(hit.name);
    const msg: ParsedMessage = { role, content: body };
    if (!['user', 'assistant', 'system', 'tool'].includes(hit.name.toLowerCase()))
      msg.author = hit.name;
    if (hit.timestamp) msg.timestamp = hit.timestamp;
    messages.push(msg);
  });

  return {
    format: usedHeadings ? 'markdown' : 'text',
    messages,
    warnings,
    truncationSuspected: false,
  };
}
