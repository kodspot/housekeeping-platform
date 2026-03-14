'use strict';

const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');
const { getFromR2 } = require('../lib/r2');

async function imageRoutes(fastify, opts) {
  // Private image proxy — serves R2 images through the API
  // Auth via query param ?token=JWT (since <img> tags can't send headers)
  fastify.get('/images/*', async (request, reply) => {
    const token = request.query.token;
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let user;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, orgId: true, role: true, isActive: true }
      });
      if (!user || !user.isActive) return reply.code(401).send({ error: 'Unauthorized' });
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const key = request.params['*'];

    // Security: block path traversal and validate key format
    if (!key || key.includes('..') || !key.startsWith('uploads/')) {
      return reply.code(404).send({ error: 'Not found' });
    }

    // Org-scoped access: key format is uploads/{orgId}/filename
    // SUPER_ADMIN can access any org's images
    const parts = key.split('/');
    if (parts.length < 3) return reply.code(404).send({ error: 'Not found' });
    if (user.role !== 'SUPER_ADMIN' && parts[1] !== user.orgId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    try {
      const response = await getFromR2(key);
      reply.header('Content-Type', response.ContentType || 'image/webp');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(response.Body);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return reply.code(404).send({ error: 'Image not found' });
      }
      throw err;
    }
  });
}

module.exports = imageRoutes;
