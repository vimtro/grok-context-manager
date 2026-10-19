/**
 * Segmentation and rule-based classification.
 *
 * Every message is split into "units" (bullets, sentences, code blocks), each unit is classified into one of
 * the seven categories with a reason string listing the signals that fired. Rules are intentionally explicit
 * and conservative: when unsure, material goes to `historical` (kept in the archive, out of the handoff)
 * rather than being promoted into working context.
 */
import type { Category, Flag, ItemKind, Role, SourceRef, StoredMessage } from '../schemas';
import { looksLikeInjection } from '../security/injection';
import { splitSentences, wordCount } from '../util/text';
import { extractDeadline, extractIdentifiers } from './extract';

export type SectionHint =
  | 'decision'
  | 'task'
  | 'question'
  | 'constraint'
  | 'completed'
  | 'knowledge'
  | 'objective'
  /** Label is stripped and the remaining text is classified normally (e.g. "Update:", "Correction:"). */
  | 'passthrough';

export interface Unit {
  text: string;
  role: Role;
  msgIndex: number;
  ref: SourceRef;
  order: number;
  section?: SectionHint;
  label?: string;
  checkbox?: 'open' | 'done';
  isCode: boolean;
  isTable: boolean;
  /** For questions: did the other party reply afterwards? */
  answered: boolean;
  /** Unit belongs to the final user/unknown message of the material. */
  inFinalUserMessage: boolean;
  /** Word count of the whole message the unit came from. */
  msgWords: number;
}

export interface Classification {
  category: Category;
  kind: ItemKind;
  confidence: number;
  reason: string;
  flags: Flag[];
  protected: boolean;
  deadline?: string;
}

// ---------------------------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------------------------

const NEGATIVE =
  /\b(?:do not|don't|dont|never|must not|mustn't|may not|shall not|should not|shouldn't|avoid|refrain from|under no circumstances|not allowed|no longer allowed|prohibited|forbidden|stop (?:using|sending|doing|posting))\b/i;
/** Assistant messages longer than this are treated as deliverables (reports/drafts). */
export const LONG_ASSISTANT_WORDS = 120;

const ONLY_RULE =
  /^(?:please\s+)?(?:only|exclusively)\s+(?:use|send|contact|share|work|post|email|reply|publish|cite|quote|book|buy|pay|approve|deploy|edit|touch)\b/i;
const CAPABILITY_NEGATION =
  /\bi (?:don't|do not|can't|cannot|couldn't|didn't|won't be able to) (?:have|see|find|know|access|open|reach|load|get|remember)\b/i;
const SECURITY =
  /\b(?:passwords?|passphrase|secrets?|credentials?|api[ -]?keys?|tokens?|oauth|ssh|private keys?|encrypt\w*|pii|personal (?:data|information)|gdpr|hipaa|soc ?2|confidential\w*|nda|security|permissions?|access control|2fa|mfa|admin access|production (?:database|db|data)|customer data|billing details|credit cards?|bank details)\b/i;
const MODAL =
  /\b(?:must|always|only|required|require|mandatory|need to|have to|make sure|ensure|at all times|without (?:explicit )?(?:approval|permission|sign-?off|consent))\b/i;
const POLICY =
  /\b(?:always|from now on|going forward|by default|as a rule|our (?:standard|policy|convention|rule)|policy|convention|remember (?:that|to)|keep in mind|every time|whenever)\b/i;
const PREFERENCE =
  /\b(?:prefers?|preferred|preference|likes? (?:it|to|when)|wants? (?:us|you|it|things) to|tone of voice|style guide|brand voice)\b/i;
const DECISION =
  /\b(?:we(?:'ve| have)? decided|i(?:'ve| have)? decided|decision (?:is|was|made)|decided (?:to|on|that|against)|agreed (?:to|on|that)|we agree|let'?s go with|(?:we're |we are |i'm |i am )?going with|we'?ll go with|we will go with|we(?:'ll| will) use|settled on|we chose|i chose|opted (?:for|to)|(?:is|was|been|got) approved|signed off|sign-off (?:given|received)|final(?:ized)? (?:decision|answer|choice)|confirmed (?:that|we)|the plan is)\b/i;
/** Assistant prose only counts as a decision when it reports the user's/team's own choice. */
const ASSISTANT_DECISION =
  /\b(?:we(?:'ve| have)? decided|you(?:'ve| have)? decided|we agreed|you agreed|you approved|you(?:'ve| have) approved|you chose|we chose|decision (?:is|was|made)|final decision|we(?:'ll| will) go with|we(?:'ll| will) use|the plan is)\b/i;
/** Assistant prose only counts as a blocker when the assistant itself is blocked. */
const ASSISTANT_BLOCKER =
  /\b(?:i'?m blocked|i am blocked|we'?re blocked|we are blocked|i(?:'m| am) waiting (?:on|for)|we(?:'re| are) (?:still )?waiting (?:on|for)|i can(?:no|')t proceed|we can(?:no|')t proceed|i need your (?:approval|sign-?off|confirmation|input|decision))\b/i;
const PROPOSAL =
  /\b(?:i (?:recommend|suggest|propose)|i'?d (?:recommend|suggest)|we (?:could|might)|you (?:could|might)|option [a-z0-9]\b|one option|alternatively|maybe|perhaps|what if|would you like|shall i|should i|do you want)\b/i;
const COMPLETION_WORDS =
  'done|completed?|finished|shipped|deployed|merged|resolved|fixed|closed|delivered|sent|published|launched|implemented|uploaded|submitted|wrapped up|booked|signed|paid|scheduled';
const COMPLETED = new RegExp(
  String.raw`(?:\b(?:i|we|it|this|that|has|have|had|was|were|is|are|just|already|successfully|now|i've|we've|it's|that's|i’ve|we’ve)\s+(?:\w+\s+)?(?:${COMPLETION_WORDS})\b|^(?:${COMPLETION_WORDS})\b|✅|☑|✔)`,
  'i',
);
const NEGATED_COMPLETION = new RegExp(
  String.raw`\b(?:not|never|yet to|still need(?:s)? to|haven't|hasn't|isn't|aren't|wasn't|weren't|didn't|won't)\b[^.]{0,25}\b(?:${COMPLETION_WORDS})\b|\b(?:once|after|when|until|before|if)\s+(?:\w+\s+){0,4}(?:${COMPLETION_WORDS})\b|\b(?:will be|to be|gets?|should be|must be|needs? to be)\s+(?:${COMPLETION_WORDS})\b`,
  'i',
);
const BLOCKER =
  /\b(?:blocked(?: on| by)?|blocker|blocking|waiting (?:on|for)|awaiting|pending (?:approval|review|confirmation|sign-?off|input|response|reply)|needs? (?:approval|sign-?off|confirmation|input|a decision) (?:from|by)|depends on|dependent on|can't proceed|cannot proceed|on hold|tbd|to be decided|to be determined|unclear (?:whether|if|how|what)|still unknown|open question|not sure (?:if|whether|how)|needs? clarification)\b/i;
const OBJECTIVE =
  /\b(?:objective|our goal|the goal|main goal|mission|the task is|our task is|we(?:'re| are) trying to|main priority|top priority|current focus|the aim is|end result|the deliverable is|purpose of this)\b/i;
const ASSISTANT_TASK =
  /\b(?:i'?ll|i will|i'm going to|i am going to|i need to|next,? i(?:'ll| will)|i plan to|we'?ll|we will|we need to|we still need to|still need(?:s)? to|remaining:|to do:|follow[ -]?up)\b/i;
const USER_TASK =
  /\b(?:todo|to-do|action items?|next steps?|need(?:s)? to|have to|has to|still need|remaining|outstanding|in progress|follow[ -]?up|please|make sure to|don't forget to|remember to|i want you to|your job is to|can you|could you)\b/i;
const IMPERATIVE_START =
  /^(?:please\s+)?(?:schedule|set up|draft|prepare|send|review|update|fix|create|write|build|call|email|add|remove|check|finish|complete|publish|deploy|book|order|follow up|reach out|contact|research|investigate|test|migrate|refactor|document|design|plan|organize|compile|summarize|translate|upload|share|invite|cancel|renew|pay|file|submit|launch|ship)\b/i;
/** "Our budget is…", "Their main contact is…" — only trusted from a human speaker. */
const FACT_SUBJECT =
  /\b(?:our|the|my|their|his|her|its)\s+(?:[\w'-]+\s+)?(?:client|customer|company|team|budget|price|pricing|target|audience|brand|stack|repo(?:sitory)?|domain|website|site|product|account|workspace|database|server|vendor|contact|manager|owner|timezone|time zone|office|address|phone|contract|agency|lead|stakeholder|deadline|launch date)s?(?:'s\s+\w+)?\s+(?:is|are|was|has|have|uses|use|=|lives|runs|costs?)\b/i;
/** "X lives in /workspace/…" — any speaker, but only together with a concrete identifier. */
const FACT_LOCATION =
  /\b(?:is at|lives (?:in|at)|located (?:in|at)|can be found (?:in|at)|stored in|hosted on|is hosted|is deployed (?:to|on)|record is|id is|number is)\b/i;
const CHATTER =
  /^(?:hi|hello|hey|hiya|thanks|thank you|thx|ty|ok|okay|k|cool|great|perfect|awesome|nice|sounds good|got it|sure|yes|yep|yeah|no problem|np|lol|haha|understood|will do|noted|alright|good (?:morning|afternoon|evening|night)|you'?re welcome|no worries|one (?:moment|sec(?:ond)?)|let me (?:check|see|look|think)|on it|working on it|checking|looking into it|great question|absolutely|of course|certainly)\b/i;
const BOILERPLATE =
  /^(?:here(?:'s| is| are)\b|let me know\b|i hope this helps|happy to help|feel free to|is there anything else|anything else\??$)/i;
export const SUPERSEDES_MARKER =
  /\b(?:instead of|rather than|changed? (?:it |this |that )?(?:from|to)|switch(?:ed|ing)? (?:from|to)|no longer|scratch that|actually,|correction|update:|updated?:|revised|replaces?|supersedes?|overrid(?:e|es|ing)|revert(?:ed|ing)? to|is now|are now|now (?:is|are|uses|use)|moved (?:from|to)|postponed|rescheduled|pushed (?:back|to))\b/i;

const LABELS: Record<string, SectionHint> = {
  decision: 'decision',
  decided: 'decision',
  agreed: 'decision',
  todo: 'task',
  'to-do': 'task',
  'to do': 'task',
  action: 'task',
  'action item': 'task',
  next: 'task',
  'next step': 'task',
  'next steps': 'task',
  task: 'task',
  pending: 'task',
  'follow-up': 'task',
  'follow up': 'task',
  blocker: 'question',
  blocked: 'question',
  question: 'question',
  'open question': 'question',
  risk: 'question',
  dependency: 'question',
  constraint: 'constraint',
  rule: 'constraint',
  policy: 'constraint',
  important: 'constraint',
  never: 'constraint',
  always: 'constraint',
  requirement: 'constraint',
  security: 'constraint',
  done: 'completed',
  completed: 'completed',
  shipped: 'completed',
  fixed: 'completed',
  resolved: 'completed',
  objective: 'objective',
  goal: 'objective',
  mission: 'objective',
  focus: 'objective',
  note: 'knowledge',
  fyi: 'knowledge',
  context: 'knowledge',
  background: 'knowledge',
  fact: 'knowledge',
  preference: 'knowledge',
  update: 'passthrough',
  correction: 'passthrough',
  revision: 'passthrough',
  clarification: 'passthrough',
};
const LABEL_RE = new RegExp(
  String.raw`^(?<label>${Object.keys(LABELS)
    .sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[-\s]/g, '[-\\s]'))
    .join('|')})s?\s*[:\-–]\s+`,
  'i',
);

function headingHint(heading: string): SectionHint | undefined {
  const h = heading.toLowerCase();
  if (
    /\b(?:in progress|todo|to-?dos|tasks?|next steps?|action items?|actions|backlog|follow[- ]?ups?|pending|remaining|plan)\b/.test(
      h,
    )
  )
    return 'task';
  if (/\b(?:decisions?|decided|agreements?|resolutions?)\b/.test(h)) return 'decision';
  if (/\b(?:open questions?|questions?|blockers?|risks?|issues?|unknowns?|dependencies)\b/.test(h))
    return 'question';
  if (
    /\b(?:constraints?|rules?|guidelines?|requirements?|policies|policy|guardrails?|don'?ts|security|boundaries|must[- ]haves?)\b/.test(
      h,
    )
  )
    return 'constraint';
  if (/\b(?:done|completed|finished|shipped|progress|changelog|accomplishments?|wins)\b/.test(h))
    return 'completed';
  if (/\b(?:objectives?|goals?|mission|purpose|focus)\b/.test(h)) return 'objective';
  if (
    /\b(?:context|background|notes|facts|reference|overview|info(?:rmation)?|knowledge|preferences|about|resources?|links?|files?|references?|documents?|assets?)\b/.test(
      h,
    )
  )
    return 'knowledge';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------------------------

const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(?<check>\[(?<state>[ xX✓])\]\s*)?(?<body>.*)$/;

export function segmentMessages(messages: StoredMessage[]): Unit[] {
  const units: Unit[] = [];
  let order = 0;
  const lastUserIdx = findLastIndex(messages, (m) => m.role === 'user' || m.role === 'unknown');

  messages.forEach((msg, msgIndex) => {
    const ref: SourceRef = { importId: msg.importId, seq: msg.seq, role: msg.role };
    if (msg.timestamp) ref.timestamp = msg.timestamp;
    const otherParty = msg.role === 'assistant' ? ['user', 'unknown'] : ['assistant'];
    // A question only counts as answered by a substantive reply from the other party ("ok"/"perfect" is not an answer).
    const answered = messages
      .slice(msgIndex + 1)
      .some(
        (m) =>
          otherParty.includes(m.role) &&
          wordCount(m.content) > 4 &&
          !(CHATTER.test(m.content.trim()) && wordCount(m.content) <= 8),
      );
    const base = {
      role: msg.role,
      msgIndex,
      ref,
      answered,
      inFinalUserMessage: msgIndex === lastUserIdx,
      msgWords: wordCount(msg.content),
    };

    let section: SectionHint | undefined;
    const lines = msg.content.split('\n');
    let paragraph: string[] = [];
    let fence: string[] | null = null;
    let table: string[] = [];

    const push = (text: string, extra: Partial<Unit> = {}) => {
      const t = text.trim();
      if (!t) return;
      const u: Unit = { ...base, text: t, order: order++, isCode: false, isTable: false, ...extra };
      if (section && !u.section) u.section = section;
      units.push(u);
    };
    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      const para = paragraph.join(' ').trim();
      paragraph = [];
      for (const sentence of splitSentences(para)) {
        const lm = LABEL_RE.exec(sentence);
        if (lm?.groups?.label) {
          push(sentence.slice(lm[0].length), {
            label: lm.groups.label.toLowerCase().replace(/\s+/g, ' '),
          });
        } else push(sentence);
      }
    };
    const flushTable = () => {
      if (table.length) push(table.join('\n'), { isTable: true });
      table = [];
    };

    for (const raw of lines) {
      if (fence) {
        fence.push(raw);
        if (/^\s*(```|~~~)/.test(raw)) {
          push(fence.join('\n'), { isCode: true });
          fence = null;
        }
        continue;
      }
      if (/^\s*(```|~~~)/.test(raw)) {
        flushParagraph();
        flushTable();
        fence = [raw];
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        flushParagraph();
        table.push(raw);
        continue;
      }
      flushTable();
      if (!raw.trim()) {
        flushParagraph();
        continue;
      }
      const heading =
        /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw) ??
        /^\s*(?:\*\*|__)([^*_]{2,60})(?:\*\*|__):?\s*$/.exec(raw);
      const labelOnly = /^\s*([A-Za-z][A-Za-z '-]{1,40}):\s*$/.exec(raw);
      if (heading || labelOnly) {
        flushParagraph();
        section = headingHint((heading ?? labelOnly)![1]!);
        continue;
      }
      const b = BULLET.exec(raw);
      if (b?.groups) {
        flushParagraph();
        const body = b.groups.body ?? '';
        const extra: Partial<Unit> = {};
        if (b.groups.check) extra.checkbox = (b.groups.state ?? ' ').trim() ? 'done' : 'open';
        const lm = LABEL_RE.exec(body);
        if (lm?.groups?.label) {
          extra.label = lm.groups.label.toLowerCase().replace(/\s+/g, ' ');
          push(body.slice(lm[0].length), extra);
        } else push(body, extra);
        continue;
      }
      // Indented continuation of the previous bullet.
      const prev = units[units.length - 1];
      if (
        /^\s{2,}\S/.test(raw) &&
        paragraph.length === 0 &&
        prev &&
        prev.msgIndex === msgIndex &&
        !prev.isCode
      ) {
        prev.text = `${prev.text} ${raw.trim()}`;
        continue;
      }
      paragraph.push(raw.trim());
    }
    if (fence) push(fence.join('\n'), { isCode: true });
    flushParagraph();
    flushTable();
  });
  return units;
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

function c(
  category: Category,
  kind: ItemKind,
  confidence: number,
  reason: string,
  flags: Flag[] = [],
): Classification {
  return { category, kind, confidence, reason, flags, protected: false };
}

const PROTECTED_KINDS: ItemKind[] = [
  'constraint',
  'decision',
  'task',
  'question',
  'blocker',
  'objective',
];

export function classifyUnit(u: Unit): Classification {
  const result = classifyInner(u);
  const deadline = extractDeadline(u.text);
  if (deadline && !u.isCode && result.category !== 'obsolete') {
    result.deadline = deadline;
    if (!result.flags.includes('deadline')) result.flags.push('deadline');
    if (
      ['temporary', 'historical'].includes(result.category) &&
      !result.flags.includes('injection_suspect')
    ) {
      result.category = 'active_work';
      result.kind = 'task';
      result.reason += '; explicit deadline';
    }
  }
  if (SUPERSEDES_MARKER.test(u.text) && !result.flags.includes('supersedes'))
    result.flags.push('supersedes');
  if (u.role === 'user' && !result.flags.includes('user_stated')) result.flags.push('user_stated');
  result.protected =
    !result.flags.includes('injection_suspect') &&
    (PROTECTED_KINDS.includes(result.kind) ||
      result.flags.includes('deadline') ||
      (result.kind === 'policy' && MODAL.test(u.text)));
  return result;
}

function classifyInner(u: Unit): Classification {
  const t = u.text;
  const words = wordCount(t);
  const fromHuman = u.role === 'user' || u.role === 'unknown' || u.role === 'system';

  if (u.isCode)
    return c(
      'historical',
      'evidence',
      0.9,
      'code block (kept in archive, referenced by resources)',
    );
  if (u.isTable) return c('historical', 'evidence', 0.85, 'table data');
  if (looksLikeInjection(t))
    return c(
      'historical',
      'evidence',
      0.95,
      'resembles an instruction-override / prompt-injection passage; quarantined for review',
      ['injection_suspect'],
    );
  if (u.role === 'tool') return c('historical', 'evidence', 0.8, 'tool output');

  // 1. Explicit structure written by a person (checkboxes, inline labels, section headings).
  if (u.checkbox === 'done') return c('obsolete', 'completed', 0.95, 'checked checkbox');
  if (u.checkbox === 'open') return c('active_work', 'task', 0.95, 'unchecked checkbox');
  const hint =
    (u.label ? (LABELS[u.label.replace(/s$/, '')] ?? LABELS[u.label]) : undefined) ?? u.section;
  const via = u.label ? `label "${u.label}:"` : 'section heading';
  if (hint && hint !== 'passthrough') {
    const neg = NEGATIVE.test(t);
    switch (hint) {
      case 'decision':
        return c('decision', 'decision', 0.9, via);
      case 'task':
        if (COMPLETED.test(t) && !NEGATED_COMPLETION.test(t))
          return c('obsolete', 'completed', 0.8, `${via}, but states completion`);
        return c('active_work', 'task', 0.9, via);
      case 'question':
        return c(
          'open_question',
          /block|wait|depend|hold/i.test(t) || u.label?.startsWith('block')
            ? 'blocker'
            : 'question',
          0.9,
          via,
        );
      case 'constraint':
        return c('permanent', 'constraint', 0.9, via, constraintFlags(t, neg));
      case 'completed':
        if (u.section === 'completed' && !u.label && /\b(?:in progress|todo|next)\b/i.test(t))
          break;
        return c('obsolete', 'completed', 0.85, via);
      case 'objective':
        return c('active_work', 'objective', 0.9, via);
      case 'knowledge':
        if (!(CHATTER.test(t) && words <= 6))
          return c('permanent', PREFERENCE.test(t) ? 'preference' : 'fact', 0.7, via);
    }
  }

  // 2. Chatter and boilerplate.
  if (
    (CHATTER.test(t) && words <= 8) ||
    (BOILERPLATE.test(t) && words <= 14) ||
    (words <= 2 && !/\d/.test(t) && extractIdentifiers(t).length === 0)
  ) {
    return c('temporary', 'chatter', 0.85, 'acknowledgement / filler');
  }

  // Long assistant outputs (reports, drafts) are deliverables, not working state: only explicit structure counts.
  if (u.role === 'assistant' && u.msgWords > LONG_ASSISTANT_WORDS) {
    return c(
      'historical',
      'evidence',
      0.6,
      'part of a long assistant output (report/draft); kept in archive',
    );
  }

  // 3. Constraints: negative or security instructions.
  const neg = NEGATIVE.test(t) && !CAPABILITY_NEGATION.test(t);
  const sec = SECURITY.test(t);
  const instructionShape =
    fromHuman || /^(?:never|do not|don't|always|must|you must|we must)\b/i.test(t);
  if (fromHuman && ONLY_RULE.test(t))
    return c('permanent', 'constraint', 0.8, 'restriction ("only …")', constraintFlags(t, false));
  if (instructionShape && (neg || (sec && MODAL.test(t)))) {
    return c(
      'permanent',
      'constraint',
      fromHuman ? 0.85 : 0.6,
      neg ? 'negative instruction' : 'security requirement',
      constraintFlags(t, neg),
    );
  }

  // 4. Completion.
  if (COMPLETED.test(t) && !NEGATED_COMPLETION.test(t)) {
    return c('obsolete', 'completed', 0.75, 'states completed work');
  }

  // 5. Decisions (proposals are not decisions until approved).
  if (
    (fromHuman ? DECISION : ASSISTANT_DECISION).test(t) &&
    !PROPOSAL.test(t) &&
    !t.trim().endsWith('?')
  ) {
    return c('decision', 'decision', fromHuman ? 0.85 : 0.7, 'decision language');
  }

  // 6. Blockers and open questions.
  if ((fromHuman ? BLOCKER : ASSISTANT_BLOCKER).test(t))
    return c('open_question', 'blocker', 0.8, 'blocker / dependency language');
  if (t.trim().endsWith('?')) {
    if (u.answered)
      return c(
        'temporary',
        'chatter',
        0.55,
        'question that was answered later in the conversation',
      );
    return c('open_question', 'question', 0.65, 'unanswered question');
  }

  // 7. Objective.
  if (OBJECTIVE.test(t) && words >= 4)
    return c('active_work', 'objective', 0.8, 'objective / goal statement');

  // 8. Tasks.
  if (u.role === 'assistant' && neg) {
    return c(
      'historical',
      'evidence',
      0.5,
      'assistant restating a rule (the original instruction is kept)',
    );
  }
  if (
    u.role === 'assistant' &&
    ASSISTANT_TASK.test(t) &&
    !/\b(?:let me (?:check|see|look|think))\b/i.test(t)
  ) {
    return c('active_work', 'task', 0.65, 'assistant commitment');
  }
  if (fromHuman && (USER_TASK.test(t) || IMPERATIVE_START.test(t))) {
    if (
      u.answered &&
      !u.inFinalUserMessage &&
      !/\b(?:todo|to-do|action items?|next steps?|still need|remaining|outstanding|follow[ -]?up|don't forget|remember to)\b/i.test(
        t,
      )
    ) {
      return c(
        'historical',
        'evidence',
        0.5,
        'request handled in-conversation (no open-task signal)',
      );
    }
    return c(
      'active_work',
      'task',
      u.inFinalUserMessage ? 0.75 : 0.65,
      u.inFinalUserMessage ? 'latest unanswered request' : 'task language',
    );
  }

  // 9. Durable knowledge.
  if (POLICY.test(t) && fromHuman) return c('permanent', 'policy', 0.7, 'standing policy');
  if (PREFERENCE.test(t)) return c('permanent', 'preference', 0.65, 'preference');
  if (fromHuman && FACT_SUBJECT.test(t))
    return c('permanent', 'fact', 0.6, 'durable fact stated by the user');
  if (
    FACT_LOCATION.test(t) &&
    extractIdentifiers(t).some((x) => x.type !== 'date' && x.type !== 'amount')
  ) {
    return c('permanent', 'fact', 0.55, 'location / identifier fact');
  }

  if (u.role === 'assistant' && words > 80)
    return c('historical', 'evidence', 0.6, 'long assistant output');
  return c('historical', 'evidence', 0.4, 'no durable signal');
}

function constraintFlags(t: string, neg: boolean): Flag[] {
  const flags: Flag[] = [];
  if (neg) flags.push('negative_instruction');
  if (SECURITY.test(t)) flags.push('security');
  return flags;
}

export const AFFIRMATION =
  /^(?:yes|yep|yeah|approved?|go ahead|let'?s do (?:it|that|this)|sounds good,? (?:go|do it|proceed)|ship it|lgtm|agreed|do it|proceed|confirmed|works for me|go for it|perfect,? (?:go|do it|proceed))\b/i;
export const PROPOSAL_SENTENCE = PROPOSAL;
