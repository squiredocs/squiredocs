/**
 * Client-side JWT utilities
 */

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

/**
 * Check if a JWT token is expired or will expire within the given margin
 * @param {string} token - JWT token string
 * @param {number} marginSeconds - Seconds before actual expiry to consider "expiring soon" (default: 60)
 * @returns {boolean} True if token is expired, expiring soon, or invalid
 */
export function isTokenExpiringSoon(token, marginSeconds = 60) {
  const decoded = decodeToken(token);
  if (!decoded) return true;
  return decoded.exp ? Date.now() >= (decoded.exp - marginSeconds) * 1000 : false;
}

/**
 * Check if a JWT token is expired
 * @param {string} token - JWT token string
 * @returns {boolean} True if token is expired or invalid
 */
export function isTokenExpired(token) {
  return isTokenExpiringSoon(token, 0);
}
