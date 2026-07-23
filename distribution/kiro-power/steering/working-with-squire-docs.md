<!-- GENERATED FILE — do not hand-edit. Source of truth: distribution/publish.mjs
     Regenerate with: node distribution/publish.mjs -->
# Working with Squire Docs

Squire Docs is the durable, attributed spec layer for spec-driven development. The spec, design, and status your team works from live in a Squire Docs document where every edit — human or agent — is attributed and revertible, and teammates and other agents all see the same doc.

For a Kiro workspace the hero move is simple: the `.kiro/specs` files you already generate become a shared, attributed, two-way-synced Squire Docs document. The spec Kiro plans and implements against stops being a file only one person can see and becomes something a product manager or designer can open, review, and refine — with every change tracked.

## What the document gives you

- **Two-way sync.** A spec stays in sync between your `.kiro/specs` file and its Squire Docs doc. Edit in either place; a push from the repo merges like an edit from a collaborator who was offline — attribution intact, no conflict dialogs.
- **Attribution.** Every edit is attributed to whoever, or whatever, made it. An agent is a collaborator, not a hidden write path: while it works it appears as a live cursor named "AgentName (UserName)", and its edits show up in version history alongside everyone else's. There is no separate, unattributed way to change the document.
- **Revertibility.** Every change lives in version history and can be reviewed, named, compared, and restored. Nothing is lost, and no edit is anonymous.

## Why host your spec here

A spec sitting untracked in `.kiro/specs` is visible to one person on one machine. Synced into Squire Docs it becomes a durable, shared, attributed home for the spec — the place the team signs off on requirements and design, and the source of truth your next run reads from. The loop in `steering/specs-sync-workflow.md` is what keeps it current.
