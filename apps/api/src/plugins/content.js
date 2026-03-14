'use strict';

const path = require('path');

async function registerContentPlugins(fastify) {
  await fastify.register(require('@fastify/multipart'), {
    attachFieldsToBody: true,
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 5,
      fields: 10
    }
  });

  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/',
    decorateReply: true
  });
}

module.exports = { registerContentPlugins };
