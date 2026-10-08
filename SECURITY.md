# Security policy

## Reporting a vulnerability

Email security@squiredocs.com. Please use private disclosure: do not open a
public issue, pull request, or discussion about the problem until it is fixed.

Include what you found, how to reproduce it (steps, requests, or a small proof
of concept), and what an attacker could do with it. We acknowledge every report,
keep you updated while we work on a fix, and credit you when the fix ships if
you would like. There is no bug bounty.

## Supported versions

Fixes go to:

- the latest Squire Docs release, for self-hosted instances; and
- the hosted service at squiredocs.com.

Older releases do not receive fixes. Upgrade a self-hosted instance by setting
`SQUIRE_VERSION` in `.env` to the new release, then running
`docker compose pull && docker compose up -d --wait`.

## More

How the hosted service protects your data is described at
https://squiredocs.com/security.
