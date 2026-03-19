/**
 * Auth module exports
 */
const router = require('./routes');
const { requireAuth, optionalAuth, requireAdmin } = require('./middleware');
const { init: initUsers } = require('./users');

module.exports = {
  router,
  requireAuth,
  requireAdmin,
  optionalAuth,
  initUsers,
};




