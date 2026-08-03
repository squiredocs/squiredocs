/**
 * Shared rendering rules for the contributor entries the server resolves.
 *
 * Attribution has to read identically wherever it is shown. The history list
 * and the version preview's contributors footer are two surfaces onto the SAME
 * `authors` array, and when only the list knew about the 045 "Synced content"
 * entry, the footer credited a relay channel as if it were a person. Any rule
 * about what an entry means belongs here, in one place, keyed on the server's
 * flags — never on a display-name match.
 */

/**
 * What the "Synced content" contributor means, for the hover title (feature 045,
 * FR-004). The server sets `isSynced` on that entry; the client only states it.
 */
export const SYNCED_CONTRIBUTION_TITLE =
  "This content arrived through a collaborator's reconnect. Its original author could not be determined.";

/**
 * The stable neutral for an author with no identity colour, matching the
 * server's own no-identity fallback in server/version-history.js. It is a fixed
 * value, not a generated one: a generated hue is salted with the current date,
 * so the same archived version would change colour overnight.
 */
export const NO_IDENTITY_COLOR = '#888888';

/** Hover text for one contributor entry. */
export function contributorTitle(author) {
  if (author?.isSynced) return SYNCED_CONTRIBUTION_TITLE;
  return author?.name || 'Unknown';
}

/** Display name. The server sends 'Unknown author' for a deleted account. */
export function contributorName(author) {
  return author?.name || 'Unknown';
}

/**
 * The identity colour to paint an entry with, or undefined when the entry is
 * not a person: the synced contribution takes no identity colour at all, which
 * is what lets each surface's stylesheet own its not-a-person treatment.
 */
export function contributorColor(author) {
  if (author?.isSynced) return undefined;
  return author?.color || NO_IDENTITY_COLOR;
}
