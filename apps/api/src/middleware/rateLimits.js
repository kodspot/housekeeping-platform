'use strict';

const strictRateLimit = {
  max: parseInt(process.env.ADMIN_RATE_LIMIT_MAX) || 5,
  timeWindow: parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW) || 900000,
  keyGenerator: (req) => req.ip
};

const loginRateLimit = {
  max: 10,
  timeWindow: 900000,
  keyGenerator: (req) => req.ip
};

module.exports = {
  strictRateLimit,
  loginRateLimit
};
