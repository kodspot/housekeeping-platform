'use strict';

const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');

// JWT authentication — verifies token, attaches user to request
async function authenticateJWT(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, orgId: true, role: true, isActive: true, name: true, email: true, tokenInvalidBefore: true }
    });

    if (!user || !user.isActive) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Reject tokens issued before a password change
    if (user.tokenInvalidBefore && decoded.iat && decoded.iat < Math.floor(user.tokenInvalidBefore.getTime() / 1000)) {
      return reply.code(401).send({ error: 'Session expired. Please log in again.' });
    }

    // For org-scoped users, verify their org is still active
    if (user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { status: true }
      });
      if (!org || org.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'Organization is not active' });
      }
    }

    // SUPER_ADMIN org context: allow operating on any org via X-Org-Id header
    if (user.role === 'SUPER_ADMIN') {
      const targetOrgId = request.headers['x-org-id'];
      if (targetOrgId) {
        const org = await prisma.organization.findUnique({
          where: { id: targetOrgId },
          select: { status: true }
        });
        if (org && org.status === 'ACTIVE') {
          user.orgId = targetOrgId;
        }
      }
    }

    request.user = user;
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

// Role check factory — SUPER_ADMIN bypasses all role checks
function requireRole(...roles) {
  return async function (request, reply) {
    if (!request.user) return reply.code(403).send({ error: 'Forbidden' });
    if (request.user.role === 'SUPER_ADMIN') return;
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

module.exports = { authenticateJWT, requireRole };
