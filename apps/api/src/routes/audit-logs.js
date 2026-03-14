'use strict';

const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

async function auditLogRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN'));

  // List audit logs — scoped to admin's own organisation only
  fastify.get('/audit-logs', async (request) => {
    const orgId = request.user.orgId;
    const { action, actorType, entityType, from, to, page, limit, search } = request.query;

    const where = { orgId };
    if (action) where.action = action;
    if (actorType) where.actorType = { equals: actorType, mode: 'insensitive' };
    if (entityType) where.entityType = { equals: entityType, mode: 'insensitive' };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from + 'T00:00:00Z');
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59Z');
    }
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } }
      ];
    }

    const take = Math.min(parseInt(limit) || 30, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.auditLog.count({ where })
    ]);

    // Resolve actor names (both admins and supervisors are in User table)
    const actorIds = [...new Set(logs.filter(l => l.actorId).map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true, role: true }
        })
      : [];
    const actorMap = new Map(actors.map(a => [a.id, a]));

    return {
      logs: logs.map(l => ({
        id: l.id,
        actorType: l.actorType,
        actorId: l.actorId,
        actorName: l.actorId ? (actorMap.get(l.actorId)?.name || 'Unknown') : l.actorType,
        actorRole: l.actorId ? (actorMap.get(l.actorId)?.role || null) : null,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        oldValue: l.oldValue,
        newValue: l.newValue,
        createdAt: l.createdAt
      })),
      total,
      page: Math.floor(skip / take) + 1,
      pages: Math.ceil(total / take)
    };
  });

  // Get distinct action types for filter dropdown
  fastify.get('/audit-logs/actions', async (request) => {
    const orgId = request.user.orgId;
    const logs = await prisma.auditLog.findMany({
      where: { orgId },
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' }
    });
    return logs.map(l => l.action);
  });

  // Get distinct entity types for filter dropdown
  fastify.get('/audit-logs/entity-types', async (request) => {
    const orgId = request.user.orgId;
    const logs = await prisma.auditLog.findMany({
      where: { orgId, entityType: { not: null } },
      select: { entityType: true },
      distinct: ['entityType'],
      orderBy: { entityType: 'asc' }
    });
    return logs.map(l => l.entityType);
  });
}

module.exports = auditLogRoutes;
