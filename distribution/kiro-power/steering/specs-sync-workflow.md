<!-- GENERATED FILE — do not hand-edit. Source of truth: distribution/publish.mjs
     Regenerate with: node distribution/publish.mjs -->
# The Squire Docs sync loop

Once a workspace's spec is synced into Squire Docs, hold this loop on every run. It is what makes the doc worth having: the doc stays current because the loop keeps it current, and every change is attributed.

## The standing loop

- **Sync before a run.** If the repo's spec file changed since it was last synced, sync it into its Squire Docs doc first, so the doc reflects what is in the repo. (First time in a workspace, work the Onboarding steps in `POWER.md` — find the spec, connect, and create the doc.)
- **Read at the start.** Read the spec from the doc at the start of the run. It is the source of truth the team edits, and it may carry human refinements that never landed back in the repo file.
- **Write back after.** After implementing, write status and design decisions back to the doc: what shipped, what changed, what is still open. The next run — yours, a teammate's, or another agent's — then starts from an accurate spec.

## The byte channel: never retype file content

Content that already exists as bytes outside the model — a file on disk, another tool's output — moves over Squire Docs' REST byte channel, not through tool parameters. This holds even after you have read the file: reading it into context does not make retyping it correct. Retyping risks silent corruption and passes content through the model that never needed to travel there.

- **Into Squire Docs:** call `import_markdown_file` and run the recipe it returns — one shell command that claims a token, imports the file over REST (frontmatter preserved), and writes a sync receipt back. You only set its `FILE=` line. Do not read the file and paste its content into a create call.
- **Out of Squire Docs:** `GET /api/docs/:docId/export?format=markdown` serializes the persisted doc, no client connection needed. Pair it with `list_documents`' `updatedSince` for incremental pulls.

When you are unsure which tool fits, call `get_tool_documentation` — it carries the full REST reference the tool descriptions are too small to hold.

## Tokens live in a file, never in the transcript

An `sk_sqd_` API token is a secret, and a secret is bytes outside the model: it moves Settings → disk → `Authorization` header, never through the conversation.

- Keep the token in `~/.squire/token`, a `0600` file.
- Reference it — `$(cat ~/.squire/token)` — and never print, echo, or paste the raw value, and never put it on a command line as an argument (argv leaks into shell history and process lists).
- When an agent mints its own token, `create_access_token` returns a one-shot claim recipe that writes the bytes straight to disk; the token itself never enters the transcript.

Context carries only what the model created or transformed — never a credential, and never file content that already exists as bytes.
