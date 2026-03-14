'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "ADMIN_KEY",
  "COOKIE_SECRET"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL ?? `http://localhost:${process.env.PORT || 3000}`;

module.exports = { REQUIRED_ENV, isProduction, APP_URL };
