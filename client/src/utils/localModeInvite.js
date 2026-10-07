/**
 * Feature 059 (FR-024, RBD-059-10): on a local-mode instance nobody but the
 * owner can sign in, so a pending invite is recorded but cannot be accepted
 * until the instance moves to team mode. The share dialog and the space
 * settings page say so.
 */
export function localInviteNote(email) {
  return `Invite recorded for ${email}. This instance is in local mode, so nobody else can sign in to accept it until it moves to team mode.`;
}
