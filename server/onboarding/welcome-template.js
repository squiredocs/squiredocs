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
 * after the "Welcome to Squire Docs!" H1. Renaming that heading requires
 * updating that prompt in lockstep.
 */
const WELCOME_DOC_TITLE = 'Welcome to Squire Docs';

const WELCOME_DOC_NODES = [
  { type: 'heading', level: 1, content: 'Welcome to Squire Docs!' },
  // The assistant injects a personalized "Welcome <First>! …" paragraph here on
  // first open (see the welcome kickoff in client AiChatContext.jsx), so the
  // template intentionally leaves this slot empty.
  {
    type: 'paragraph',
    content:
      'Squire Docs is a collaborative editor for spec-driven development: design docs, ADRs, and specs that engineers, PMs, and coding agents write together, with every edit attributed.',
  },
  { type: 'heading', level: 2, content: 'How it works' },
  {
    type: 'paragraph',
    content:
      'Everyone — and every agent — works in the same living document. Every edit is attributed, versioned, and reversible, and the whole thing can sync to your repos as markdown.',
  },
  {
    type: 'mermaid',
    content: [
      'graph TB',
      '    subgraph Clients["Contributors"]',
      '        T["You & your team<br/>(live cursors)"]',
      '        A["Squire Assistant<br/>(in-app AI)"]',
      '        C["Your coding agents<br/>(Claude Code via MCP)"]',
      '    end',
      '',
      '    D[("Living document<br>Yjs CRDT<br>attributed · versioned · reversible")]',
      '',
      '    T -->|"edits"| D',
      '    A -->|"edits"| D',
      '    C -->|"reads / writes"| D',
      '    C -->|"reads / writes"| R',
      '    D <-->|"markdown two-way sync"| R[("Your git repo<br>.md files")]',
      '',
      '    style D fill:#e1f5fe,stroke:#0288d1,stroke-width:2px',
      '    style R fill:#e8f5e9,stroke:#388e3c,stroke-width:2px',
      '    style T fill:#e3f2fd,stroke:#1976d2',
      '    style A fill:#fce4ec,stroke:#c62828',
      '    style C fill:#f3e5f5,stroke:#6a1b9a',
    ].join('\n'),
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
  { type: 'heading', level: 2, content: 'About Squire Docs' },
  {
    type: 'paragraph',
    content:
      'Squire Docs was built by engineering leaders who needed a better way to move from high-level thinking to specs a team—human or agent—can execute. It is currently in free public beta, including a $10 AI credit allotment for new users.',
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
];

module.exports = { WELCOME_DOC_TITLE, WELCOME_DOC_NODES };
