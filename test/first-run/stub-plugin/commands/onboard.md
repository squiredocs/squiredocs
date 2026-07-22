---
description: SCAFFOLDING FOR TESTING — stub /squire:onboard. Real onboarding coaching is M2.
---

**SCAFFOLDING FOR TESTING — real onboarding coaching content is M2.**

This is a placeholder `/squire:onboard` command used only by the first-run
rehearsal harness to prove the harness runs end to end and the transcript grader
produces an accurate report. It deliberately implements exactly ONE line of the
coaching contract (so the grader can demonstrate a PASS) and none of the rest
(so the grader can demonstrate the expected FAILs). The full coaching flow —
connect walkthrough, bare authorization URL, paste-back on localhost-callback
failure, silent reconnect, byte-channel sync, doc-URL payoff, and the
read-spec/write-back loop — is authored in milestone M2, not here.

When this command runs, output exactly the following line and nothing more:

Signing in creates your Squire Docs account automatically — there is no separate signup step.
