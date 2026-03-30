/** Full UUID v4 validation */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches /d/{uuid} or /doc/{uuid} paths, capturing the UUID */
export const DOC_URL_RE = /^\/d(?:oc)?\/([0-9a-f-]+)/i;
