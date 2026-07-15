# Contract: `nextSteps` block

New payload element built ONCE in `server/mcp/auth/login-service.js` (a pure
`buildNextSteps(baseUrl, credentialFilePath)` helper) and attached inside `getStatus` to BOTH
delivery payloads it constructs: the default approved payload and the inline approved payload. Both
the `login_status` tool and the REST `GET /api/login/status` route call `getStatus`, so both
consumers carry an identical block by construction (FR-012) — they cannot drift.

## Placement (RD-3, G3)

- **Present in**: the one-shot approved (recipe) payload AND the inline payload — for BOTH the tool
  and the REST status route (four delivery sites, one builder).
- **Absent from**: `POST /api/login/start` (not a delivery); the raw-byte claim response of
  `GET /api/login/claim` and its alias (would corrupt the 0600 credential file — RD-3).

## Shape (FR-011, FR-013)

```json
{
  "nextSteps": {
    "registerMcp": "claude mcp add --transport http squire <baseUrl>/mcp --header \"Authorization: Bearer $(cat ~/.squire/credential)\"",
    "restRecipes": [
      { "what": "List your documents", "command": "curl -fsS -H \"Authorization: Bearer $(cat ~/.squire/credential)\" \"<baseUrl>/api/docs\"" },
      { "what": "Create a document from a markdown file", "command": "curl -fsS -X POST -H \"Authorization: Bearer $(cat ~/.squire/credential)\" -H \"Content-Type: text/markdown\" --data-binary @doc.md \"<baseUrl>/api/docs/import\"" },
      { "what": "Export a document as markdown", "command": "curl -fsS -H \"Authorization: Bearer $(cat ~/.squire/credential)\" \"<baseUrl>/api/docs/<docId>/export?format=markdown\" -o doc.md" }
    ],
    "note": "Credential file path follows wherever you wrote it in the claim step (default ~/.squire/credential)."
  }
}
```
(Exact field names are an implementation detail pinned by the tests; the content requirements below
are the contract.)

## Requirements

- **Credentialed registration one-liner (FR-011a)**: `claude mcp add … --header "Authorization:
  Bearer $(cat <file>)"` with the claim recipe's default credential file path pre-filled. The **bare
  (uncredentialed) `claude mcp add` form MUST NOT appear anywhere in the payload.**
- **Top three REST recipes (FR-011b)**: list documents (`GET /api/docs`, G1), create-from-markdown
  (`POST /api/docs/import`), export (`GET /api/docs/:docId/export?format=markdown`) — each runnable
  as-is against the claimed credential file. Not a full REST reference (agents.md /
  `get_tool_documentation({ tool: "rest_api" })` remain the reference).
- **No secrets (FR-013)**: the block references the credential ONLY via the file path
  (`$(cat <file>)`); it contains no credential material in any form.
- **Path honesty (spec edge case)**: wording makes clear the pre-filled path follows wherever the
  agent actually wrote the credential (default `~/.squire/credential`, matching `buildClaimCommand`).
- **Sizing (spec edge case)**: the block must not push the approved payload past what MCP clients
  render reliably (~2 KB) — three recipes, not a reference.

## Invariants (tested — `login-next-steps.test.js`)

- Tool approved payload, REST approved payload, tool inline payload, REST inline payload each contain
  a `nextSteps` block whose registration one-liner is the `--header` credentialed form and whose
  three recipes are present and runnable.
- The bare `claude mcp add … <baseUrl>/mcp` form (no `--header`) appears in NO delivery payload.
- No `sk_sqd_` / credential material anywhere in any `nextSteps`.
- The raw claim response body is exactly the credential bytes + `\n` (no `nextSteps`).
