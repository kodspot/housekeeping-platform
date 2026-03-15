'use strict';

const crypto = require('crypto');
const { z } = require('zod');

const BCRYPT_COST = 12;

const isProduction = process.env.NODE_ENV === 'production';

// Password strength: min 8 chars, uppercase, lowercase, digit
const passwordSchema = z.string().min(8).max(100)
  .refine(p => /[A-Z]/.test(p), { message: 'Password must contain at least one uppercase letter' })
  .refine(p => /[a-z]/.test(p), { message: 'Password must contain at least one lowercase letter' })
  .refine(p => /\d/.test(p), { message: 'Password must contain at least one number' });

const COOKIE_CONFIG = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 86400000,
  path: '/'
};

if (isProduction && process.env.COOKIE_DOMAIN) {
  COOKIE_CONFIG.domain = process.env.COOKIE_DOMAIN;
}

// Hash the admin key for secure cookie comparison
function hashAdminKey(key) {
  return crypto.createHmac('sha256', process.env.COOKIE_SECRET).update(key).digest('hex');
}

module.exports = {
  BCRYPT_COST,
  COOKIE_CONFIG,
  hashAdminKey,
  passwordSchema
};
