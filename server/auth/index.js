/**
 * Auth module exports
 */
const router = require('./routes');
const { requireAuth, optionalAuth } = require('./middleware');
const { init: initUsers } = require('./users');

module.exports = {
  router,
  requireAuth,
  optionalAuth,
  initUsers,
};


