/**
 * Client-side JWT utilities
 */

/**
 * Check if a JWT token is expired
 * @param {string} token - JWT token string
 * @returns {boolean} True if token is expired or invalid
 */
export function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)));
    return decoded.exp ? Date.now() >= decoded.exp * 1000 : false;
  } catch {
    return true; // Treat unparseable tokens as expired (fail-secure)
  }
}

/**
 * Decode a JWT token payload without verification
 * @param {string} token - JWT token string
 * @returns {object|null} Decoded payload or null if invalid
 */
export function decodeToken(token) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)));
  } catch {
    return null;
  }
}
