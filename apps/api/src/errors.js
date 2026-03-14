const path = require('path');
const { appendFile, mkdir } = require('fs/promises');
const { isProduction } = require('./config/env');

async function logError(err) {
  try {
    const logDir = path.join(__dirname, '../../../data/logs');
    await mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, 'error.log');
    await appendFile(logPath, `[${new Date().toISOString()}] ${err.stack}\n\n`);
  } catch (e) {
    console.error('Failed to write to error log:', e);
  }
}

function validateImageBuffer(buffer, mimetype) {
  const signatures = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'image/webp': [0x52, 0x49, 0x46, 0x46]
  };

  const sig = signatures[mimetype];
  if (!sig) return false;
  return sig.every((byte, i) => buffer[i] === byte);
}

function registerErrorHandlers(fastify) {
  fastify.setErrorHandler(async (error, request, reply) => {
    fastify.log.error(error);
    await logError(error);

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too many requests',
        retryAfter: error.after,
        message: `Rate limit exceeded. Retry after ${error.after}`
      });
    }

    if (error.name === 'ZodError') {
      return reply.status(400).send({
        error: 'Validation failed',
        details: error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    if (error.code === 'P2002') {
      return reply.status(409).send({
        error: 'Duplicate entry',
        message: 'A record with this value already exists'
      });
    }

    if (error.code?.startsWith('P')) {
      return reply.status(500).send({
        error: 'Database error',
        message: isProduction ? 'Internal server error' : error.message
      });
    }

    reply.status(error.statusCode || 500).send({
      error: 'Internal server error',
      message: isProduction ? 'Something went wrong' : error.message
    });
  });

  const fs = require('fs');
  const path = require('path');
  const publicDir = path.join(__dirname, '..', 'public');

  fastify.setNotFoundHandler((request, reply) => {
    // Clean URL support: /admin-login → /admin-login.html
    if (request.method === 'GET') {
      const cleanPath = request.url.split('?')[0].replace(/^\//, '');

      // /scan/CODE → serve scan.html (smart QR landing page)
      if (cleanPath.startsWith('scan/')) {
        return reply.sendFile('scan.html');
      }

      if (cleanPath && !cleanPath.includes('.') && fs.existsSync(path.join(publicDir, cleanPath + '.html'))) {
        return reply.sendFile(cleanPath + '.html');
      }
    }
    reply.status(404).send({ error: 'Not found', message: `Route ${request.method} ${request.url} not found` });
  });
}

module.exports = { logError, validateImageBuffer, registerErrorHandlers };
