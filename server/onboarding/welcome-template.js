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
 * Feature 058 (FR-034, RBD-058-22): the nodes are built per instance.
 * buildWelcomeDocNodes({ appUrl, hosted }) builds the connection commands, the
 * MCP config URL, the agents.md link, and the documentation link from APP_URL,
 * and includes the support paragraph and the AI-credit sentence only on the
 * hosted service (a self-hosted instance links the GitHub issue tracker). WELCOME_DOC_NODES is the hosted build.
 *
 * Coupling: the assistant's welcome kickoff (client AiChatContext.jsx,
 * buildWelcomeKickoffPrompt) inserts the personalized greeting immediately
 * after the "Welcome to Squire Docs!" H1. Renaming that heading requires
 * updating that prompt in lockstep.
 */
const WELCOME_DOC_TITLE = 'Welcome to Squire Docs';

const HOSTED_APP_URL = 'https://squiredocs.com';

const GITHUB_REPO_URL = 'https://github.com/squiredocs/squiredocs';

const HOSTED_CREDIT_SENTENCE =
  ' On squiredocs.com, every account gets $10 of AI credits a month for the built-in assistant.';

/**
 * @param {{ appUrl: string, hosted: boolean }} opts
 * @returns {Array<object>} node specs for buildYjsNode
 */
function buildWelcomeDocNodes({ appUrl, hosted }) {
  const origin = String(appUrl).replace(/\/+$/, '');
  const nodes = [
    { type: 'heading', level: 1, content: 'Welcome to Squire Docs!' },
    // The assistant injects a personalized "Welcome <First>! …" paragraph here on
    // first open (see the welcome kickoff in client AiChatContext.jsx), so the
    // template intentionally leaves this slot empty.
    {
      type: 'paragraph',
      content:
        'Squire Docs is a collaborative editor for people and AI agents. Your coding agents edit the same documents you do, live, and everything stays in sync with markdown in your repo.',
    },
    { type: 'heading', level: 2, content: 'How it works' },
    {
      type: 'paragraph',
      content:
        'You, your team, and your agents work in the same live document. Every edit is attributed to whoever made it, every version can be restored, and each document can sync both ways with a markdown file in your repo.',
    },
    {
      type: 'mermaid',
      content: [
        'graph TB',
        '    subgraph Clients["Contributors"]',
        '        T["You and your team<br/>(live cursors)"]',
        '        A["Squire Docs assistant<br/>(built-in AI)"]',
        '        C["Your coding agents<br/>(Claude Code, Codex, any MCP agent)"]',
        '    end',
        '',
        '    D[("Live document<br>attributed, versioned, restorable")]',
        '',
        '    T -->|"edits"| D',
        '    A -->|"edits"| D',
        '    C -->|"reads / writes"| D',
        '    C -->|"reads / writes"| R',
        '    D <-->|"two-way markdown sync"| R[("Your git repo<br>.md files")]',
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
        'Squire Docs speaks MCP, so Claude Code, Codex, and other agents can read and edit your docs alongside you. Each agent shows up as a named cursor, and its edits are attributed to it.',
    },
    {
      type: 'paragraph',
      content: [
        { text: 'Claude Code', marks: ['bold'] },
        ': in a terminal (not inside a running Claude Code session), run:',
      ],
    },
    {
      type: 'codeBlock',
      language: 'bash',
      content: `claude mcp add --transport http squire ${origin}/mcp && claude mcp login squire`,
    },
    {
      type: 'paragraph',
      content: [
        { text: 'Codex', marks: ['bold'] },
        ': in a terminal, run:',
      ],
    },
    {
      type: 'codeBlock',
      language: 'bash',
      content: `codex mcp add squire --url ${origin}/mcp && codex mcp login squire`,
    },
    {
      type: 'paragraph',
      content: [
        'Using a different agent? Point it at ',
        { text: `${origin}/agents.md`, marks: [{ type: 'link', href: `${origin}/agents.md` }] },
        '. Most MCP agents can read that page and connect themselves. For Cursor, Kiro, Claude Desktop, and others, see ',
        {
          text: 'Agents & MCP',
          marks: [{ type: 'link', href: `${origin}/documentation/agents-and-mcp` }],
        },
        '.',
      ],
    },
    { type: 'heading', level: 2, content: 'About Squire Docs' },
    {
      type: 'paragraph',
      content: [
        'Squire Docs is open source under the MIT license. The code, issues, and releases are on ',
        { text: 'GitHub', marks: [{ type: 'link', href: GITHUB_REPO_URL }] },
        hosted ? '.' + HOSTED_CREDIT_SENTENCE : '.',
      ],
    },
  ];

  // Hosted: the support paragraph names the hosted service's support address
  // and page. Self-hosted: bugs and ideas go to the GitHub issue tracker.
  if (!hosted) {
    nodes.push({
      type: 'paragraph',
      content: [
        'Found a bug or have an idea? ',
        { text: 'Open an issue on GitHub', marks: [{ type: 'link', href: `${GITHUB_REPO_URL}/issues` }] },
        '.',
      ],
    });
  }
  if (hosted) {
    nodes.push({
      type: 'paragraph',
      content: [
        'Need help? ',
        { text: 'Email support', marks: [{ type: 'link', href: 'mailto:contact@squiredocs.com' }] },
        ' or use the ',
        { text: 'Get Support', marks: [{ type: 'link', href: 'https://squiredocs.com/support' }] },
        ' link in the Account menu.',
      ],
    });
  }
  return nodes;
}

// The hosted build.
const WELCOME_DOC_NODES = buildWelcomeDocNodes({ appUrl: HOSTED_APP_URL, hosted: true });

module.exports = { WELCOME_DOC_TITLE, WELCOME_DOC_NODES, buildWelcomeDocNodes };
