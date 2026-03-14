'use strict';

const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

/**
 * Create a notification for a user (called internally by other routes).
 */
async function createNotification({ orgId, userId, type, title, body, entityId }) {
  return prisma.notification.create({
    data: { orgId, userId, type, title, body: body || null, entityId: entityId || null }
  });
}

/**
 * Notify all active admins of an org.
 */
async function notifyAdmins(orgId, { type, title, body, entityId }) {
  const admins = await prisma.user.findMany({
    where: { orgId, role: 'ADMIN', isActive: true },
    select: { id: true }
  });
  if (!admins.length) return;
  await prisma.notification.createMany({
    data: admins.map(a => ({
      orgId, userId: a.id, type, title, body: body || null, entityId: entityId || null
    }))
  });
}

async function notificationRoutes(fastify) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Unread count (lightweight poll endpoint) ──
  fastify.get('/notifications/unread-count', async (request) => {
    const count = await prisma.notification.count({
      where: { userId: request.user.id, isRead: false }
    });
    return { count };
  });

  // ── List notifications (paginated, newest first) ──
  fastify.get('/notifications', async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 20, 50);
    const offset = parseInt(request.query.offset) || 0;

    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: request.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.notification.count({ where: { userId: request.user.id } }),
      prisma.notification.count({ where: { userId: request.user.id, isRead: false } })
    ]);

    return { notifications, total, unread };
  });

  // ── Mark all as read (MUST be before :id route to avoid conflict) ──
  fastify.patch('/notifications/read-all', async (request) => {
    await prisma.notification.updateMany({
      where: { userId: request.user.id, isRead: false },
      data: { isRead: true }
    });
    return { success: true };
  });

  // ── Clear all read notifications ──
  fastify.delete('/notifications/clear-read', async (request) => {
    const result = await prisma.notification.deleteMany({
      where: { userId: request.user.id, isRead: true }
    });
    return { success: true, deleted: result.count };
  });

  // ── Mark single notification as read ──
  fastify.patch('/notifications/:id/read', async (request, reply) => {
    const { id } = request.params;
    const notif = await prisma.notification.findFirst({
      where: { id, userId: request.user.id }
    });
    if (!notif) return reply.code(404).send({ error: 'Not found' });

    await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });
    return { success: true };
  });

  // ── Delete single notification ──
  fastify.delete('/notifications/:id', async (request, reply) => {
    const { id } = request.params;
    const notif = await prisma.notification.findFirst({
      where: { id, userId: request.user.id }
    });
    if (!notif) return reply.code(404).send({ error: 'Not found' });

    await prisma.notification.delete({ where: { id } });
    return { success: true };
  });
}

/**
 * Notify all active supervisors of an org.
 */
async function notifySupervisors(orgId, { type, title, body, entityId }) {
  const supervisors = await prisma.user.findMany({
    where: { orgId, role: 'SUPERVISOR', isActive: true },
    select: { id: true }
  });
  if (!supervisors.length) return;
  await prisma.notification.createMany({
    data: supervisors.map(s => ({
      orgId, userId: s.id, type, title, body: body || null, entityId: entityId || null
    }))
  });
}

module.exports = notificationRoutes;
module.exports.createNotification = createNotification;
module.exports.notifyAdmins = notifyAdmins;
module.exports.notifySupervisors = notifySupervisors;
