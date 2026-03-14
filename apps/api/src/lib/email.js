'use strict';

const nodemailer = require('nodemailer');

let sesTransporter = null;

function getSesTransporter() {
  if (sesTransporter) return sesTransporter;
  const host = process.env.SES_SMTP_HOST;
  const user = process.env.SES_SMTP_USER;
  const pass = process.env.SES_SMTP_PASS;
  if (!host || !user || !pass) return null;

  sesTransporter = nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100
  });
  return sesTransporter;
}

const SES_FROM = process.env.SES_FROM_EMAIL || 'noreply@example.com';

module.exports = {
  getSesTransporter,
  SES_FROM
};
