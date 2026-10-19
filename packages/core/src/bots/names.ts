/**
 * Quick-add helpers: turn a list of bot names (typed, or pasted from the Grok Bot sidebar) into bot IDs.
 * GCM cannot read the bot list from the Grok Bot app (no supported API), so the user pastes or types names.
 */
import { sha256 } from '../util/hash';

export const QUICK_ADD_MAX_NAMES = 200;
export const QUICK_ADD_MAX_CHARS = 100_000;
const MAX_NAME_CHARS = 60;
const MAX_NAME_WORDS = 6;

/** "Chief of Staff" → "chief-of-staff"; non-Latin names get a stable hashed ID ("bot-1a2b3c4d"). */
export function botIdFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || `bot-${sha256(name.trim().toLowerCase()).slice(0, 8)}`;
}

const UNIT =
  's|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years';
const NOISE: RegExp[] = [
  new RegExp(`^\\d+\\s*(?:${UNIT})(?:\\s+ago)?$`, 'i'), // 2h, 5 min ago
  /^(?:just now|now|today|yesterday|earlier|last week|this week|last month|older)$/i,
  /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?$/i,
  /^\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?$/, // 10/19, 19.10.2026
  /^\d{4}-\d{2}-\d{2}/, // 2026-10-19
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?$/i,
  /^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$/i, // 14:05, 2:05 pm
  /^(?:new chat|new bot|new group chat|search|settings|bots|chats|group chats|all bots|home|help|online|offline|idle|busy|working|thinking|archived|pinned|unread|more|show more|see all)$/i,
];

function clean(raw: string): string {
  return raw
    .split('\t')[0]!
    .replace(/^\s*(?:[-*•·▪◦‣>]+|\d+[.)]|\[[ xX]?\])\s*/, '')
    .replace(/^@/, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoise(name: string): boolean {
  if (name.length < 2 || name.length > MAX_NAME_CHARS) return true;
  if (!/\p{L}/u.test(name)) return true; // no letters at all (counts, avatars, emoji-only)
  if (name.split(' ').length > MAX_NAME_WORDS) return true; // message preview, not a name
  if (/https?:\/\/|www\./i.test(name)) return true;
  return NOISE.some((re) => re.test(name));
}

export interface ParsedBotNames {
  names: { id: string; name: string }[];
  /** Lines that looked like timestamps, previews or app labels rather than bot names. */
  ignored: string[];
}

/**
 * Parses one name per line (commas and semicolons also separate names). Strips bullets, numbering and @mentions,
 * drops timestamps / message previews / app labels, and de-duplicates by derived ID (first spelling wins).
 */
export function parseBotNames(text: string): ParsedBotNames {
  const names: ParsedBotNames['names'] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\r\n,;]+/)) {
    const name = clean(raw);
    if (!name) continue;
    if (isNoise(name)) {
      if (ignored.length < 50) ignored.push(name.slice(0, MAX_NAME_CHARS));
      continue;
    }
    const id = botIdFromName(name);
    if (seen.has(id)) continue;
    seen.add(id);
    names.push({ id, name });
    if (names.length >= QUICK_ADD_MAX_NAMES) break;
  }
  return { names, ignored };
}
