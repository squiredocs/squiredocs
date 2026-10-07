# Promotion notes: 062-oss-launch-messaging

Records relaxations consciously accepted during this feature's pipeline, deploy
preconditions, and pre-existing defects found but deliberately not fixed. Later
phases append here.

## Spec phase (2026-10-07)

- **No relaxations introduced by the spec.** It encodes the ratified design
  ("Proposal: Open Source Launch Messaging", D1 to D8, with D3 amended to name
  MIT) plus the RATIFIED-BY-DEFAULT decisions in `clarifications-needed.md`
  (RBD-062-1 to RBD-062-15).

- **Merge-queue precondition (D5, FR-042).** The implementation branch stays
  unmerged until the launch gate: history scrub done, repository public at
  `https://github.com/squiredocs`, feature 060 merged so
  `/documentation/self-hosting` and `/install.sh` resolve, and a `LICENSE` file
  (MIT) in the repository. The spec and plan merge as usual. Until the gate
  opens, the new copy's "open source" and install claims are false.

- **Repository URL repoint (D4).** Every GitHub link points at the organization.
  When the repository name is decided, the links and the copy-rules test's
  expected URL change together.

- **Claims Sam confirms before the gate opens** (not verifiable from the
  repository; see the spec's Assumptions): same code as the public repository;
  MIT license and LICENSE file; managed instances in the customer's chosen
  cloud region including EU, with documents, database, and backups kept there;
  dedicated single-tenant managed instances run and supported by us.

- **Follow-ons (not this feature):**
  1. `client/src/components/LoginPage.jsx` sign-in subtitle still reads "Write
     with AI, right in your doc" (RBD-062-1).
  2. Header nav of the documentation and blog renderers
     (`client/scripts/render-documentation.mjs`, `client/scripts/render-blog.mjs`)
     lacks the new "GitHub" and "Self-host" links (RBD-062-2).
  3. A short clip or screenshot of an agent cursor editing next to a human
     cursor for landing section 1 (D7, RBD-062-11).
  4. GitHub star count in the nav once there are stars (RBD-062-2).
  5. If the team-mode amendment (061) is ratified and shipped, the self-hosted
     sign-in cell in the pricing table may add passwords and OIDC (RBD-062-7).

- **Pre-existing defects noticed, not fixed here:** none in the code paths this
  feature touches. The current landing page contains one literal em dash in
  prose (line 247) and bare "Squire" in prose (line 214, "Design in Squire");
  both are removed by the rewrite rather than fixed in place.
