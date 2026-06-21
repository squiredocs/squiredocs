/**
 * Welcome document content template.
 *
 * Mirrors the canonical welcome doc. Each entry is a node spec understood by
 * buildYjsNode() (server/mcp/yjs/node-builder.js): headings, paragraphs,
 * bulletList/listItem, and a mermaid diagram (a tagged element holding the
 * diagram source as text — same shape buildYjsNode produces for `content`).
 *
 * Note: rich textStyle color marks from the source doc are intentionally
 * dropped here — buildYjsNode only supports simple marks (bold/italic/link),
 * and color is non-essential for onboarding.
 */
const WELCOME_DOC_TITLE = 'Welcome to Squire Docs';

const WELCOME_DOC_NODES = [
  { type: 'heading', level: 1, content: 'Welcome to Squire Docs!' },
  { type: 'heading', level: 2, content: 'Write with AI, right in your doc' },
  {
    type: 'paragraph',
    content:
      'Squire Docs was built by engineering leaders who needed a better way to move from high-level thinking to finished plans. It is currently in free public beta, including a $10 AI credit allotment for new users.',
  },
  { type: 'heading', level: 2, content: "What's Next?" },
  { type: 'paragraph', content: 'Choose a path to begin:' },
  {
    type: 'bulletList',
    children: [
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
      'graph LR\n    A[Big Idea] --> B{Assistant}\n    B --> C[Research]\n    B --> D[Drafting]\n    B --> E[Refine]\n    C & D & E --> F[Finished Document]',
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
      { text: 'Email support', marks: [{ type: 'link', href: 'mailto:sam@squiredocs.com' }] },
      ' or use the ',
      { text: 'Get Support', marks: [{ type: 'link', href: 'https://squiredocs.com/support' }] },
      ' link in the Account menu.',
    ],
  },
];

module.exports = { WELCOME_DOC_TITLE, WELCOME_DOC_NODES };
