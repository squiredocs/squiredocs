// Cached Intl formatters — constructing a formatter is the expensive part, so we
// reuse one instance per format rather than building a fresh one on every call.
const DATE_FMT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const SHORT_DATE_FMT = new Intl.DateTimeFormat(); // locale default (date only)
const VERSION_TS_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** e.g. "Jun 20, 2026 at 8:16 AM" — used in the document list. */
export function formatDateTime(value) {
  const date = new Date(value);
  return `${DATE_FMT.format(date)} at ${TIME_FMT.format(date)}`;
}

/**
 * e.g. "Jan 5, 4:30 PM" — used for version and sub-version rows in the
 * version-history list. Deliberately YEAR-LESS: the list already groups rows
 * under a month-and-year heading, so repeating the year on every row is noise.
 *
 * Moved here from `HierarchicalVersionList.jsx` in feature 042 (FR-015,
 * DEC-10), which resolved a name collision: three components each had a local
 * `formatDateTime` producing a DIFFERENT string, so the name promised an
 * interchangeability that did not exist. They now live together under distinct
 * names, and every rendered string is unchanged.
 */
export function formatVersionRowTimestamp(value) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * e.g. "Jun 20, 2026, 8:16 AM" — used in the admin tables.
 *
 * Returns `'Never'` for a falsy input: "when did this credential last do
 * anything" has a meaningful answer for something that never has, and that
 * answer travels WITH the formatter rather than being repeated at each call
 * site. Moved here in feature 042 (FR-015, DEC-10).
 */
export function formatAdminDateTime(value) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** e.g. "June 20 at 8:16 AM" — used in the version-history header. */
export function formatVersionTimestamp(value) {
  return VERSION_TS_FMT.format(new Date(value));
}

/**
 * Coarse relative time ("just now", "5m ago", "Yesterday", "3d ago"), falling
 * back to a locale date for anything older than a week. Used in the chat list.
 */
export function formatRelativeTime(value) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMin = Math.floor((now - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'Yesterday';
  if (diffD < 7) return `${diffD}d ago`;
  return SHORT_DATE_FMT.format(new Date(value));
}
