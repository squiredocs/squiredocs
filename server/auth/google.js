/**
 * Google OAuth utilities
 * Handles authorization URL generation and token exchange
 */
const { OAuth2Client } = require('google-auth-library');

// Configuration from environment variables
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback';

// OAuth2 client instance
let oauth2Client = null;

/**
 * Get or create the OAuth2 client instance
 */
function getOAuth2Client() {
  if (!oauth2Client) {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.');
    }
    oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
  }
  return oauth2Client;
}

/**
 * Generate Google OAuth authorization URL
 * @returns {string} The authorization URL to redirect users to
 */
function generateAuthUrl(state) {
  const client = getOAuth2Client();

  const scopes = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  const opts = {
    access_type: 'offline', // Get refresh token for offline access
    scope: scopes,
    prompt: 'consent', // Force consent screen to ensure we get refresh token
  };

  if (state) {
    opts.state = state;
  }

  return client.generateAuthUrl(opts);
}

/**
 * Exchange authorization code for tokens
 * @param {string} code - The authorization code from Google callback
 * @returns {Promise<{tokens: object}>} The tokens from Google
 */
async function exchangeCodeForTokens(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Verify Google ID token and extract user profile
 * @param {string} idToken - The ID token from Google
 * @returns {Promise<{googleId: string, email: string, name: string, picture: string}>} User profile
 */
async function verifyIdToken(idToken) {
  const client = getOAuth2Client();
  
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  
  const payload = ticket.getPayload();
  
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture || null,
  };
}

module.exports = {
  generateAuthUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  getOAuth2Client,
};




