# Contract: sign-in page, consent page, claim page, invite notes

Serves FR-017, FR-018, FR-024, FR-028, SC-003, RBD-059-9, -10, -20, -21.

## Provider data on the client

`client/src/hooks/useAuthProviders.js`: one `GET /auth/providers` per page
load (shared promise). Returns `{ status: 'loading' | 'ready' | 'error', info }`.
On `error`, `info` is the team-mode Google fallback
`{ mode: 'team', signupOpen: true, providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }] }`.

## Sign-in page (`/login`, `/signup`)

| Element | Team mode, Google only (must equal today) | Local mode |
| --- | --- | --- |
| Headline | "Welcome Back" on `/login`, "Get Started" on `/signup` | "Welcome Back" on both |
| Action | one button per provider: Google icon + "Sign in with Google" (`/login`) or "Sign up with Google" (`/signup`) | instruction block: "This Squire Docs instance signs in with a one-time link." then the command `docker compose exec app squire claim-link` (copyable) and "Open the link it prints." |
| Footer | "Don't have an account? Sign Up" / "Already have an account? Sign In" | none |
| Legal links | as 058 decides (`SQUIRE_HOSTED`) | as 058 decides |
| Loading | headline only; action and footer appear when the fetch settles | same |

Error codes the page maps to messages: existing four plus `provider_disabled`
("That sign-in method is not enabled on this instance."), `account_exists`
("An account with this email already exists. Sign in with the method you used
before. Linking another sign-in method from Settings arrives with team mode."),
`link_invalid`, `instance_claimed`, `claim_invalid` (text in
`signin-links.md`).

`AuthContext.login(returnTo, startPath = '/auth/google')` builds
`${startPath}?returnTo=...` exactly as today.

## Consent page, unauthenticated state (`FirstRunConsent`)

| Element | Team mode, Google only (must equal today) | Local mode |
| --- | --- | --- |
| Headline | "Connect to Squire Docs" | same |
| Lead | "Sign in to Squire Docs with your Google Account to connect {agent}." | "Sign in to this Squire Docs instance to connect {agent}." |
| Value points, grant, revocation | unchanged | unchanged |
| Grant sentence tail | "not your Google account." | "This grants {agent} access to your Squire Docs account. Once connected, it will be able to {grant}." (no Google clause) |
| Action | `<a>` "Continue with Google" to `${startPath}?returnTo=<this /authorize URL>` | instruction: run `docker compose exec app squire claim-link`, open the link, then "come back to {agent} and try again; it reopens this page." No link is offered. |

`/authorize-preview` adds a local-mode card so the copy can be reviewed.

## Claim page (`/claim#<token>`)

States:

| State | Rendered |
| --- | --- |
| no fragment or malformed token | "Open the link printed by `docker compose exec app squire claim-link`." No form. |
| peeking | "Checking your link..." |
| `valid`, `kind = claim` | headline "Create the owner account"; Name and Email fields prefilled from `prefill` (editable, both required); Continue |
| `valid`, `kind = signin` | headline "Sign in"; "Sign in as {name} ({email})"; Continue (no fields) |
| `valid: false` | the `link_invalid` message; no form |
| `?error=claim_invalid` without fragment | "Enter a name and a valid email address, then open the link from your terminal again." |

Behavior:

- The fragment is read once, then removed with `history.replaceState(null, '', '/claim')`.
- Continue submits a real form: `<form method="post" action="/auth/signin-link">` with hidden `token` (and `name`, `email` for a claim). The browser follows the server's redirect.
- Client-side validation mirrors the server's (required name, email shape) to avoid spending a round trip, but the server is authoritative.

## Invite notes (local mode only)

- `ShareDialog.jsx`: when the share response is an invite (`response.data.invite`) and `mode === 'local'`, the success line becomes: "Invite recorded for {email}. This instance is in local mode, so nobody else can sign in to accept it until it moves to team mode." Team mode text unchanged ("Invitation sent to {email}").
- `SpaceSettingsPage.jsx`: same note under the invite form after a pending invite is created in local mode.

## Admin page

`signupSource === 'signin_link'` renders "Sign-in link".
