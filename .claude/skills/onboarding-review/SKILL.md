---
name: onboarding-review
description: Review new-user onboarding activity from the production database — find recent signups and summarize their chats, documents, and AI usage. Use when asked to review new signups, what new users did, or onboarding activity.
argument-hint: "[count | email | time window]  (default: signups in the past 24 hours)"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# Review new-user onboarding activity

Summarize what recent signups did on their first visit: what they asked the
assistant, what documents got created, and where they dropped off. Pulls from the
**production** `collab` Postgres database.

`$ARGUMENTS` controls scope:
- empty → **all signups in the past 24 hours** (the default)
- a number `N` → the newest N users
- an email → that specific user
- a time window (e.g. `past 48 hours`, `this week`) → all signups in that window

## Read this first — privacy

This reads **real end-users' private chats and document contents**. That's a
deliberate step, not a casual one. Before pulling content:

- Confirm the requester actually wants **full content** vs. just **metadata**
  (counts, titles, timestamps). When unsure, ask with `AskUserQuestion`.
- Don't widen scope beyond what was asked (e.g. don't dump every user).
- This is the app owner reviewing their own system — fine — but keep the summary
  to what's useful (intent, output, drop-off, product signal), not gratuitous
  reproduction of private text.

## Step 1 — Confirm you're on PROD, not local dev

**This bit us before.** The active kubectl context can silently drift to
`minikube` (local dev), whose DB is a totally separate, stale dataset. If the
"newest user" looks impossibly old or recent data is missing, you're on the wrong
cluster — that's the tell, not a data-loss incident.

```bash
kubectl config current-context
```

- Prod is **`k3s-squiredocs`** (the hardened cluster). Local dev is **`minikube`**.
- If not on `k3s-squiredocs`, switch deliberately (confirm with the user first
  since it's prod): `kubectl config use-context k3s-squiredocs`

## Step 2 — Resolve the Postgres pod (its name changes on recycle)

Never hardcode the pod name — it changes whenever the pod restarts.

```bash
PGPOD=$(kubectl -n collab get pods --no-headers | grep postgres | grep -i running | awk '{print $1}' | head -1)
echo "POD=$PGPOD"
```

All queries run as:
```bash
kubectl -n collab exec "$PGPOD" -- bash -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "<SQL>"'
```

## Step 3 — Identify the target user(s)

Default scope is **everyone who signed up in the past 24 hours**, with activity
counts in one shot:

```sql
SELECT u.id, u.email, u.name, u.created_at,
  (SELECT count(*) FROM chats     WHERE user_id=u.id)    AS chats,
  (SELECT count(*) FROM documents WHERE creator_id=u.id) AS docs,
  (SELECT count(*) FROM ai_usage_log WHERE user_id=u.id) AS ai_calls
FROM users u
WHERE u.created_at >= now() - interval '24 hours'
ORDER BY u.created_at DESC;
```

For other scopes from `$ARGUMENTS`: swap the `WHERE` for a different interval
(e.g. `'48 hours'`, `'7 days'`), or drop it and use `ORDER BY created_at DESC
LIMIT N` for the newest N, or `WHERE email = '...'` for one user.

Sanity-check `created_at` against today's date — a stale-looking max date means
you're on the wrong cluster (see Step 1). If the window returns zero rows on a
day you expect signups, that's also a wrong-cluster tell.

This query already covers Step 4's per-user counts, so you can skip Step 4 unless
you want them for a single user picked by email.

## Step 4 — Activity overview

Put the user id in a shell var. **Do not name it `UID`** — that's reserved in zsh
and breaks the command. Use `U`.

```bash
U=<user-uuid>
kubectl -n collab exec "$PGPOD" -- bash -lc "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -P pager=off -c \"
SELECT (SELECT count(*) FROM chats     WHERE user_id='$U')    AS chats,
       (SELECT count(*) FROM documents WHERE creator_id='$U') AS docs,
       (SELECT count(*) FROM ai_usage_log WHERE user_id='$U') AS ai_calls;\""
```

## Step 5 — Documents

Document bodies live in Yjs (binary). Use **`document_search_index.content_text`**
for readable plain text. Pull docs for the whole cohort in one query by joining
`users` on the same time window, and skip the boilerplate (see below):

```sql
SELECT u.name, d.title, d.created_at, left(dsi.content_text, 700) AS excerpt
FROM documents d
JOIN users u ON u.id = d.creator_id
LEFT JOIN document_search_index dsi ON dsi.doc_id = d.id
WHERE u.created_at >= now() - interval '24 hours'
  AND d.title <> 'Welcome to Squire Docs'
ORDER BY u.created_at DESC, d.created_at;
```

For a single user, swap the `WHERE` for `d.creator_id = '<U>'`.

Every new user is auto-seeded a **"Welcome to Squire Docs"** document — that one is
boilerplate, not user-authored (the filter above drops it). A user whose only doc
is the Welcome one created nothing real. Call out only the docs they actually made.

## Step 6 — Chats

Each new user gets an auto-created **"Welcome"** chat. Messages are a `jsonb`
array; text lives in `parts[].text` (where `type='text'`), role in `role`, and the
seeded opening system prompt is tagged `metadata.kind = 'welcome-kickoff'` — label
or skip it (it's not something the user typed).

Pull all cohort chats in one query by joining `users` on the time window:

```sql
SELECT u.name, m.ord, m.msg->>'role' AS role,
  coalesce(m.msg->'metadata'->>'kind', '') AS kind,
  left(string_agg(p->>'text', ' ') FILTER (WHERE p->>'type'='text'), 1200) AS text
FROM chats c
JOIN users u ON u.id = c.user_id
CROSS JOIN LATERAL jsonb_array_elements(c.messages) WITH ORDINALITY AS m(msg, ord)
LEFT JOIN LATERAL jsonb_array_elements(m.msg->'parts') AS p ON true
WHERE u.created_at >= now() - interval '24 hours'
GROUP BY u.name, u.created_at, m.ord, m.msg
ORDER BY u.created_at DESC, m.ord;
```

For a single chat, swap the `WHERE` for `c.id = '<chat-id>'` and drop `u.name`.
Add `-A -F"|"` to the `psql` flags so wide multilingual text isn't truncated by
the table border.

To see the assistant's actual edits (tool calls), select parts where
`type <> 'text'` — `tool-modify` parts carry the `script` and a `diff`. An
assistant message with **no parts at all** (no text and no tool calls) is a
genuine empty generation — flag it as a likely failure, not a user bounce.

If output is large, it's saved to a tool-results file — `Read` it rather than
re-running with tighter limits.

## Step 7 — Write the summary

When the scope is a cohort (the default), open with a one-line rollup before the
per-user breakdown: how many signed up, how many produced a real document vs.
dropped off, and how many returned. A user returned only if `last_login_at` is
meaningfully later than `created_at` — signup auto-logs-in, so a sub-second gap
means they never came back:

```sql
SELECT name, last_login_at - created_at AS session_gap
FROM users WHERE created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

Then, per user, lead with the takeaway, not a data dump:
- **Who & when** — name, email, signup time, whether they returned (`last_login_at`).
- **What they wanted** — their first real request in their own words (skip the
  `welcome-kickoff` prompt).
- **What the product produced** — the real document(s) created and what's in them.
- **Drop-off** — did they reply to the assistant's follow-up, or vanish?
- **Product signal** — recurring patterns worth flagging (e.g. several recent
  signups wanting AI *video* generation the product can't do; non-English/RTL
  usage; export/image-insertion friction). Cross-reference earlier reviews when a
  pattern repeats.

Keep claims tied to evidence. If you assert something broke or misbehaved, verify
it from the edit trace before stating it as fact — don't infer a bug from the
assistant's own narration.
