/**
 * Auth module exports
 */
const router = require('./routes');
const { requireAuth, requireAuthOrCookie, optionalAuth, requireAdmin } = require('./middleware');
const { init: initUsers } = require('./users');

module.exports = {
  router,
  requireAuth,
  requireAuthOrCookie,
  requireAdmin,
  optionalAuth,
  initUsers,
};




