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
