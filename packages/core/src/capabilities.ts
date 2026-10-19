/**
 * Machine-readable Grok Bot capability matrix (mirrors docs/CAPABILITY-MATRIX.md).
 * Surfaced by `gcm doctor`, the dashboard and the `gcm_describe_capabilities` MCP tool so that the product
 * never claims more than the platform supports.
 */

export type CapabilityStatus =
  'VERIFIED_SUPPORTED' | 'VERIFIED_UNSUPPORTED' | 'EXPERIMENTAL' | 'UNKNOWN';

export interface Capability {
  id: string;
  question: string;
  status: CapabilityStatus;
  evidence: string;
  sources: string[];
  approach: string;
}

export const CAPABILITIES_CHECKED_AT = '2026-10-19';

const DOCS = 'https://cursor.com/docs/grok-bot';
const DOCS_WORK = 'https://cursor.com/docs/grok-bot/work';
const FORUM_COMPACT =
  'https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333';
const FORUM_CONNECTORS = 'https://forum.cursor.com/t/grokbot-custom-connectors/169965/5';
const COMPOSIO = 'https://composio.dev/blog/how-to-add-mcp-servers-to-grok-bot';
const COMMUNITY_CLI = 'https://github.com/adamanz/grok-bot-skill';

export const CAPABILITIES: Capability[] = [
  {
    id: 'conversation-api',
    question: 'Official conversation-management API for Grok Bot?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence:
      'Official docs describe no API. The only programmatic route found is a community macOS CLI that decrypts the local desktop session and calls undocumented gateway routes.',
    sources: [DOCS, DOCS_WORK, COMMUNITY_CLI],
    approach: 'Not used. GCM never touches session secrets, private endpoints or app internals.',
  },
  {
    id: 'mcp-read-history',
    question: 'Can an MCP server read the Grok Bot conversation history?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence:
      'MCP servers only receive the arguments a bot passes to a tool call; nothing documents transcript access for connectors.',
    sources: [FORUM_CONNECTORS, COMPOSIO],
    approach:
      'Tools accept explicitly supplied text only (user paste, or a bot summarising what it can see).',
  },
  {
    id: 'mcp-compact-transcript',
    question: 'Can an MCP server compact or prune the platform-managed transcript?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence:
      'Cursor staff (Aug–Sep 2026): long conversations are automatically summarised near the model context limit; explicit compaction controls are not shipped and have no timeline.',
    sources: [FORUM_COMPACT],
    approach:
      'GCM compacts only its own stored copy and prepares a handoff for a fresh conversation.',
  },
  {
    id: 'reset-chat',
    question: 'Can the user reset a chat without deleting the bot?',
    status: 'EXPERIMENTAL',
    evidence:
      'Staff reference a “Reset chat” control that is destructive to the transcript. A Windows user could not find it in Grok Bot 0.47.0 and support could not confirm it on that build. Not in the official docs.',
    sources: [FORUM_COMPACT],
    approach:
      'Offered as an optional, explicitly-approved manual step with a destructive-action warning. Never automated.',
  },
  {
    id: 'reset-preserves-state',
    question: 'Does Reset chat preserve memory, skills, routines and connectors?',
    status: 'EXPERIMENTAL',
    evidence:
      'Staff state durable state (profile, memory, routines, skills, connectors, shared files) survives Reset chat. Not documented; not independently verified.',
    sources: [FORUM_COMPACT],
    approach:
      'Reported to the user as a staff statement, not a guarantee. GCM keeps its own identity record and checkpoints regardless.',
  },
  {
    id: 'reset-windows',
    question: 'Is Reset chat available on the current Windows app?',
    status: 'UNKNOWN',
    evidence:
      'Reported missing on Windows 0.47.0 (Sept 2026). Desktop app ships for Windows x64/Arm64.',
    sources: [FORUM_COMPACT, DOCS],
    approach:
      'The wizard asks the user whether their build shows the control; default recommendation is a new group chat.',
  },
  {
    id: 'new-chat-same-bot',
    question: 'Can a new one-to-one conversation be started with an existing bot?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence:
      'Docs: “New chat … then select Create new Bot”, or select 2–6 bots for a group chat. Forum: a new session on the same bot is not available.',
    sources: [DOCS_WORK, FORUM_COMPACT],
    approach: 'Use a new group chat that includes the bot (non-destructive) instead.',
  },
  {
    id: 'group-chat-excludes-history',
    question: 'Does a new group chat exclude the old one-to-one history?',
    status: 'EXPERIMENTAL',
    evidence:
      'Staff reportedly said a new group chat does not pull in the old transcript (second-hand in the forum thread). Bot memory still applies by design.',
    sources: [FORUM_COMPACT, DOCS_WORK],
    approach:
      'Recommended route, labelled “context reduction unverified”. Users can record before/after usage to check.',
  },
  {
    id: 'connector-create-conversation',
    question: 'Can a custom MCP connector create or select conversations?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence: 'No documented connector capability for conversation control.',
    sources: [FORUM_CONNECTORS, DOCS_WORK],
    approach: 'No such tool is exposed. No tool named reset/compact for Grok Bot exists in GCM.',
  },
  {
    id: 'transcript-export',
    question: 'Can user-provided transcript exports be imported?',
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'Grok Bot has no documented export, but users can copy conversation text; GCM parses text, Markdown, JSON and JSONL.',
    sources: [DOCS_WORK],
    approach: 'Import marks coverage as unknown/partial unless the user asserts it is complete.',
  },
  {
    id: 'usage-telemetry',
    question: 'Is per-bot token usage telemetry exposed?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence:
      'Docs say usage resets weekly and link to plan pages; no per-bot or per-message token metrics are documented.',
    sources: [DOCS],
    approach:
      'GCM estimates text size locally and lets users record measurements they obtain themselves, kept separate from estimates.',
  },
  {
    id: 'remote-mcp',
    question: 'Can a custom remote MCP connector be added?',
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'Staff (Aug 2026): no settings form, but ask the bot to add the server; the endpoint must be reachable over the internet (streamable HTTP or SSE). API keys are stored as headers on the server entry.',
    sources: [FORUM_CONNECTORS, COMPOSIO],
    approach: 'GCM ships an authenticated streamable-HTTP MCP server for deployment behind HTTPS.',
  },
  {
    id: 'stdio-mcp-cloud',
    question: 'Can a stdio MCP server run on the bot’s cloud computer?',
    status: 'EXPERIMENTAL',
    evidence:
      'Third-party guide: the bot runs the command on its cloud computer. Not in official docs.',
    sources: [COMPOSIO],
    approach:
      'Documented as an optional deployment (`gcm mcp serve --stdio` on the cloud computer). Data then lives on the shared cloud computer.',
  },
  {
    id: 'localhost-mcp',
    question: 'Can the bot reach an MCP server on the user’s Windows localhost?',
    status: 'VERIFIED_UNSUPPORTED',
    evidence: 'Staff: a localhost-only server on your PC is not reachable from the cloud bot.',
    sources: [FORUM_CONNECTORS],
    approach:
      'Local default binds 127.0.0.1 for local clients only; remote use needs an HTTPS tunnel or host.',
  },
  {
    id: 'skills',
    question: 'Can custom skills be created and reused?',
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'Docs: skills are reusable task instructions created by asking the bot, referenced with “/”, available across bots. File format/location is not documented.',
    sources: [DOCS_WORK],
    approach:
      'GCM ships SKILL.md content the user asks the bot to save as a skill; it relies only on chat plus optional GCM tools.',
  },
  {
    id: 'shared-filesystem',
    question: 'Can the shared cloud filesystem hold handoff files?',
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'Docs: all bots share one cloud computer; shared workspace at /workspace persists. It is shared by every bot of the account.',
    sources: [DOCS, DOCS_WORK],
    approach:
      'Optional handoff files under /workspace; documented as NOT a per-bot security boundary.',
  },
  {
    id: 'connector-scope',
    question: 'Are connectors scoped per bot?',
    status: 'EXPERIMENTAL',
    evidence:
      'Connected apps are account-wide; third-party guides describe enabling a plugin per bot as a separate step.',
    sources: [DOCS_WORK, COMPOSIO],
    approach: 'GCM enforces per-token bot scopes server-side; one token per bot is recommended.',
  },
];
