'use strict';

const path = require('path');
const { isProduction, APP_URL } = require('../config/env');
const { COOKIE_CONFIG } = require('../lib/security');

async function registerSecurityPlugins(fastify) {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(url => url.trim())
    : [APP_URL];

  await fastify.register(require('@fastify/cors'), {
    origin: isProduction ? allowedOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Org-Id']
  });

  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: isProduction ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });

  await fastify.register(require('@fastify/rate-limit'), {
    max: parseInt(process.env.RATE_LIMIT_MAX) || 1000,
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry in ${context.after}`,
      retryAfter: context.after
    })
  });

  await fastify.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
    parseOptions: COOKIE_CONFIG
  });
}

module.exports = { registerSecurityPlugins };
