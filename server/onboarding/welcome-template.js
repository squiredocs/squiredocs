/**
 * Welcome document content template.
 *
 * Mirrors the canonical welcome doc
 * (https://squiredocs.com/d/f7948d4a-2a4d-4f3f-a395-9f222017b2f8).
 * Each entry is a node spec understood by
 * buildYjsNode() (server/mcp/yjs/node-builder.js): headings, paragraphs,
 * bulletList/listItem, codeBlock (plain text + language attr), and mermaid
 * diagrams (a tagged element holding the diagram source as text — same shape
 * buildYjsNode produces for `content`).
 *
 * Note: rich textStyle color marks from the source doc are intentionally
 * dropped here — buildYjsNode only supports simple marks (bold/italic/link),
 * and color is non-essential for onboarding.
 *
 * Coupling: the assistant's welcome kickoff (client AiChatContext.jsx,
 * buildWelcomeKickoffPrompt) inserts the personalized greeting immediately
 * after the "Write with AI, right in your doc" heading, above "What's Next?".
 * Renaming either heading requires updating that prompt in lockstep.
 */
const WELCOME_DOC_TITLE = 'Welcome to Squire Docs';

const WELCOME_DOC_NODES = [
  { type: 'heading', level: 1, content: 'Welcome to Squire Docs!' },
  {
    type: 'paragraph',
    content:
      'Squire Docs is a collaborative editor for spec-driven development: design docs, ADRs, and specs that engineers, PMs, and coding agents write together — with every edit attributed.',
  },
  { type: 'heading', level: 2, content: 'Write with AI, right in your doc' },
  // The assistant injects a personalized "Welcome <First>! …" paragraph here on
  // first open (see the welcome kickoff in client AiChatContext.jsx), so the
  // template intentionally leaves this slot empty.
  { type: 'heading', level: 2, content: "What's Next?" },
  { type: 'paragraph', content: 'Choose a path to begin:' },
  {
    type: 'bulletList',
    children: [
      {
        type: 'listItem',
        content:
          'Spec: Paste a rough idea and I will structure it into a design doc or ADR your team—and your coding agents—can execute.',
      },
      {
        type: 'listItem',
        content: 'Research: Ask me to look up a topic and I will draft a document based on what I find.',
      },
      {
        type: 'listItem',
        content: 'Draft: Tell me what you need to write—a proposal, a plan, or a memo—and we will build it together.',
      },
      {
        type: 'listItem',
        content: 'Refine: Paste an existing draft here and ask for feedback, formatting help, or a structural review.',
      },
    ],
  },
  {
    type: 'mermaid',
    content:
      'graph LR\n    A[Big Idea] --> B{Assistant}\n    B --> G[Spec]\n    B --> C[Research]\n    B --> D[Draft]\n    B --> E[Refine]\n    G & C & D & E --> F[Finished Document]',
  },
  { type: 'heading', level: 2, content: 'How it all fits together' },
  {
    type: 'paragraph',
    content:
      'Everyone — and every agent — works in the same living document. Every edit is attributed, versioned, and reversible, and the whole thing syncs to your repo as markdown.',
  },
  {
    type: 'mermaid',
    content:
      'graph TB\n    T["You & your team<br/>(live cursors)"] --> D\n    A["Squire Assistant<br/>(in-app AI)"] --> D\n    C["Your coding agents<br/>(Claude Code via MCP)"] --> D\n    D["One living document<br/>every edit attributed, versioned, reversible"]\n    D <-->|"markdown two-way sync"| R["Your git repo"]',
  },
  { type: 'heading', level: 2, content: 'Connect your coding agents' },
  {
    type: 'paragraph',
    content:
      'Squire Docs speaks MCP, so agents like Claude Code can read and edit your docs right alongside you. In a terminal (not inside a running agent session), run:',
  },
  {
    type: 'codeBlock',
    language: 'bash',
    content: 'claude mcp add --transport http squire https://squiredocs.com/mcp && claude mcp login squire',
  },
  {
    type: 'paragraph',
    content: [
      'Your browser opens to authorize with the account you are signed in with, and from then on your agent appears in your docs as a named, attributed cursor. See the ',
      { text: 'agent guide', marks: [{ type: 'link', href: 'https://squiredocs.com/agents.md' }] },
      ' and ',
      {
        text: 'Agents & MCP',
        marks: [{ type: 'link', href: 'https://squiredocs.com/documentation/agents-and-mcp' }],
      },
      ' for the full picture.',
    ],
  },
  { type: 'heading', level: 2, content: 'Meet your Squire Docs Assistant' },
  {
    type: 'paragraph',
    content:
      'I am here to keep your work organized and moving forward. I handle the meticulously operational work—formatting, restructuring, and filling in boilerplate—so you can focus on the big picture. If you ever feel lost or need a second pair of eyes, just ask.',
  },
  {
    type: 'paragraph',
    content: [
      'Need help? ',
      { text: 'Email support', marks: [{ type: 'link', href: 'mailto:contact@squiredocs.com' }] },
      ' or use the ',
      { text: 'Get Support', marks: [{ type: 'link', href: 'https://squiredocs.com/support' }] },
      ' link in the Account menu.',
    ],
  },
  { type: 'heading', level: 2, content: 'About Squire Docs' },
  {
    type: 'paragraph',
    content:
      'Squire Docs was built by engineering leaders who needed a better way to move from high-level thinking to specs a team—human or agent—can execute. It is currently in free public beta, including a $10 AI credit allotment for new users.',
  },
];

module.exports = { WELCOME_DOC_TITLE, WELCOME_DOC_NODES };
