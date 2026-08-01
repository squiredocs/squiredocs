---
slug: collaboration-and-sharing
title: Collaboration and sharing
description: Real-time editing, presence, offline editing, the Owner, Editor, and Viewer roles, sharing, and invitations in Squire Docs.
order: 5
---

Squire Docs is built for several people to work on the same document at once. This page covers real-time editing, presence, offline editing, roles, and sharing.

## Real-time editing

Several people can edit the same document at the same time. Changes appear as they are made. Merging is automatic: there are no locks and no conflict dialogs. This holds whether the editors are people or AI agents.

Every change is recorded with who made it (a person by name, an agent by its name alongside the person it acts for) and shows up that way in [version history](/documentation/version-history).

## Presence

While a document is open, you can see who else is in it. The header shows the avatars of everyone present; click one to jump to that person's cursor. Each collaborator shows up in the document as a cursor with its own color; the name label appears briefly when they move and comes back when you click their avatar.

AI agents appear too, marked with a robot badge over the avatar of the person they act for and labeled "AgentName (UserName)". An agent shows up as a single presence no matter how many things it is doing at once. Agents announce themselves even when they work outside the editor: while an agent imports or syncs markdown into the document, you see it arrive, a brief highlight over what changed, and it leave.

## Offline editing

You can keep editing while you are disconnected. An "Offline" banner with a Retry button appears while the connection is down, your changes accumulate locally, and they merge back in automatically when the connection returns. No separate step is needed. This applies to a document you already have open; loading the app fresh requires a connection.

## Roles

Every document grants access by role:

- **Owner**: full control. Can edit, share, manage access, and delete the document.
- **Editor**: can edit the document and manage its sharing.
- **Viewer**: read-only access. A viewer can add other viewers, but cannot make edits.

## Sharing

Share a document from the three-dot menu in the editor, or from the three-dot menu on its row in the document list, to give someone access as an Editor or a Viewer. The email field autocompletes against people who already have accounts, and it leaves out you and anyone already on the document.

The same dialog manages existing access: editors and owners can change a collaborator's role or remove their access. Removing someone takes effect within a minute, even if they have the document open.

You can share with someone who has no account yet. They receive an email invitation and gain access automatically the first time they sign in. Pending invitations appear under "Pending invites" and can be cancelled by an editor or owner.

A viewer can only grant the Viewer role. The Owner role cannot be granted to anyone.

During the public beta, outbound invitation email is turned off per user by default; contact support to have it enabled for your account. While it is off, sharing still grants access and records the invitation; only the email is held back.
