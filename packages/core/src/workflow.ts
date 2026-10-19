/**
 * Guided handoff/reset workflow:
 *   Analyze → Checkpoint → Verify → Handoff → User-approved platform action → Validate
 *
 * GCM has no supported way to observe or change Grok Bot's transcript, so after the user acts the state is
 * EXTERNAL_RESET_UNVERIFIED — never "reset succeeded". CONTINUATION_VERIFIED only means the bot in the new
 * conversation demonstrably loaded the handoff; it is not evidence that platform context was reduced.
 */
import type { CheckpointContent, HandoffRecord, HandoffState, PlatformAction } from './schemas';
import { contentWords, overlap } from './util/text';

export const TRANSITIONS: Record<HandoffState, HandoffState[]> = {
  CHECKPOINT_READY: ['ARCHIVE_VERIFIED', 'FAILED_RECOVERABLE'],
  ARCHIVE_VERIFIED: ['HANDOFF_READY', 'FAILED_RECOVERABLE'],
  HANDOFF_READY: ['USER_ACTION_REQUIRED', 'FAILED_RECOVERABLE'],
  USER_ACTION_REQUIRED: ['EXTERNAL_RESET_UNVERIFIED', 'HANDOFF_READY', 'FAILED_RECOVERABLE'],
  EXTERNAL_RESET_UNVERIFIED: ['CONTINUATION_VERIFIED', 'FAILED_RECOVERABLE'],
  CONTINUATION_VERIFIED: [],
  FAILED_RECOVERABLE: [
    'HANDOFF_READY',
    'USER_ACTION_REQUIRED',
    'EXTERNAL_RESET_UNVERIFIED',
    'CONTINUATION_VERIFIED',
  ],
};

export const STATE_DESCRIPTIONS: Record<HandoffState, string> = {
  CHECKPOINT_READY: 'Checkpoint saved and its content hash verified.',
  ARCHIVE_VERIFIED:
    'Every source import behind the checkpoint is present and its integrity hash matches.',
  HANDOFF_READY: 'Compact handoff prompt generated and ready to copy.',
  USER_ACTION_REQUIRED: 'Waiting for you to perform the chosen step in the Grok Bot app.',
  EXTERNAL_RESET_UNVERIFIED:
    'You reported doing the platform step. GCM cannot observe Grok Bot, so whether its context was actually cleared is unverified.',
  CONTINUATION_VERIFIED:
    'The bot’s reply in the new conversation contained the checkpoint code and the key facts. (This does not prove platform context was reduced.)',
  FAILED_RECOVERABLE: 'A step failed. Nothing was deleted; you can retry from the handoff.',
};

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface PlatformActionGuide {
  action: PlatformAction;
  title: string;
  destructive: boolean;
  reducesPlatformContext: 'unverified' | 'no';
  steps: string[];
  caveats: string[];
}

export function platformGuide(action: PlatformAction, botName: string): PlatformActionGuide {
  switch (action) {
    case 'new_group_chat':
      return {
        action,
        title: 'Start a new group chat that includes this bot (recommended, non-destructive)',
        destructive: false,
        reducesPlatformContext: 'unverified',
        steps: [
          'In the Grok Bot app choose New chat (the + button).',
          `Select ${botName} and at least one other bot (group chats need 2–6 bots; a coordinator such as Chief of Staff works well).`,
          `Mention @${botName} and paste the handoff prompt.`,
          'Keep the old one-to-one conversation as history. Do not delete the bot.',
          'Paste the bot’s first reply back into GCM to verify continuation.',
        ],
        caveats: [
          'Cursor staff have said a new group chat does not pull in the old one-to-one transcript, but this is not documented and GCM cannot verify what Grok Bot loads.',
          'Bot memory (preferences, facts, summaries of prior work) still applies by design.',
          'Later messages in the old one-to-one chat will continue to use that long transcript.',
        ],
      };
    case 'reset_chat':
      return {
        action,
        title: 'Reset chat (destructive to the platform transcript)',
        destructive: true,
        reducesPlatformContext: 'unverified',
        steps: [
          `Only if your Grok Bot build shows a “Reset chat” control for ${botName}. It was not visible on at least one Windows build (0.47.0).`,
          'Confirm the GCM archive and checkpoint are verified (this workflow already checked them).',
          'Use Reset chat — never “Delete Bot”, which removes the bot’s profile, conversation and routines.',
          'Paste the handoff prompt as the first message of the reset conversation.',
          'Paste the bot’s first reply back into GCM to verify continuation.',
        ],
        caveats: [
          'Reset chat permanently clears the platform transcript. Cursor staff describe it as “destructive for the transcript itself, not a clean compact”.',
          'Staff state that profile, memory, routines, skills, connectors and shared-computer files survive a reset. GCM cannot verify this.',
          'GCM only holds what you imported; anything not imported is gone from the transcript after a reset.',
        ],
      };
    case 'continue_in_place':
      return {
        action,
        title: 'Paste into the existing conversation (no reset)',
        destructive: false,
        reducesPlatformContext: 'no',
        steps: ['Paste the handoff prompt into the current conversation with the bot.'],
        caveats: [
          'This refocuses the bot on the current state but does not shrink the transcript Grok Bot reprocesses; it will not reduce usage.',
        ],
      };
  }
}

export interface ContinuationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ContinuationResult {
  passed: boolean;
  checks: ContinuationCheck[];
}

/** Checks a bot's reply in the new conversation against the handoff's verification request. */
export function verifyContinuation(
  handoff: Pick<HandoffRecord, 'verificationCode'>,
  content: CheckpointContent,
  reply: string,
): ContinuationResult {
  const checks: ContinuationCheck[] = [];
  const replyWords = contentWords(reply);
  const codeOk = reply.toUpperCase().includes(handoff.verificationCode.toUpperCase());
  checks.push({
    name: 'checkpoint code',
    passed: codeOk,
    detail: codeOk
      ? `Reply contains ${handoff.verificationCode}.`
      : `Reply does not contain ${handoff.verificationCode}.`,
  });
  if (content.objective) {
    const score = overlap(contentWords(content.objective.text), replyWords);
    checks.push({
      name: 'objective restated',
      passed: score >= 0.3,
      detail: `Objective term overlap ${(score * 100).toFixed(0)}% (needs ≥30%).`,
    });
  }
  const top = content.pendingTasks.slice(0, 3);
  if (top.length) {
    const hits = top.filter((t) => overlap(contentWords(t.text), replyWords) >= 0.34).length;
    const needed = Math.min(2, top.length);
    checks.push({
      name: 'pending tasks restated',
      passed: hits >= needed,
      detail: `${hits} of the top ${top.length} pending task(s) recognised (needs ${needed}).`,
    });
  }
  return { passed: checks.every((c) => c.passed), checks };
}
