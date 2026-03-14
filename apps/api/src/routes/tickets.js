'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { createNotification, notifyAdmins } = require('./notifications');

const TICKET_INCLUDE = {
  location: { select: { id: true, name: true, type: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  assignedTo: { select: { id: true, name: true } }
};

async function processImage(request, orgId) {
  const imageFile = request.body.image;
  if (!imageFile || !imageFile.mimetype) return null;
  const file = Array.isArray(imageFile) ? imageFile[0] : imageFile;
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.mimetype)) throw new Error('Invalid image type. Use JPEG, PNG or WebP.');
  const buffer = await file.toBuffer();
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Image too large. Max 5MB.');
  if (!validateImageBuffer(buffer, file.mimetype)) throw new Error('Invalid image file');
  return uploadToR2(buffer, file.mimetype, orgId);
}

async function ticketRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Create ticket (ADMIN or SUPERVISOR, supports multipart for optional image) ──
  fastify.post('/tickets', async (request, reply) => {
    const orgId = request.user.orgId;
    let data, imageUrl = null;

    if (request.isMultipart()) {
      const fv = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };
      data = {
        locationId: fv(request.body.locationId),
        title: fv(request.body.title)?.trim(),
        description: fv(request.body.description)?.trim() || null,
        priority: fv(request.body.priority) || 'NORMAL'
      };
      // Validate priority from multipart before proceeding
      const validPrioritiesMp = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
      if (!validPrioritiesMp.includes(data.priority)) {
        return reply.code(400).send({ error: 'Invalid priority' });
      }
      try { imageUrl = await processImage(request, orgId); } catch (e) {
        return reply.code(400).send({ error: e.message });
      }
    } else {
      const schema = z.object({
        locationId: z.string().uuid(),
        title: z.string().min(1).max(200).trim(),
        description: z.string().max(1000).optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL')
      });
      data = schema.parse(request.body);
    }

    if (!data.locationId || !data.title) {
      return reply.code(400).send({ error: 'locationId and title are required' });
    }
    const validPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
    if (data.priority && !validPriorities.includes(data.priority)) {
      return reply.code(400).send({ error: 'Invalid priority' });
    }

    const location = await prisma.location.findFirst({ where: { id: data.locationId, orgId } });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    const ticket = await prisma.ticket.create({
      data: {
        orgId,
        locationId: data.locationId,
        createdById: request.user.id,
        title: data.title,
        description: data.description || null,
        imageUrl,
        priority: data.priority || 'NORMAL'
      },
      include: TICKET_INCLUDE
    });

    return ticket;
  });

  // ── List tickets ──
  // Supervisors only see tickets assigned to them; Admins see all
  fastify.get('/tickets', async (request) => {
    const orgId = request.user.orgId;
    const { status, locationId, priority, source, page, limit, search, assignedToId, from, to } = request.query;

    const where = { orgId };
    if (request.user.role === 'SUPERVISOR') {
      where.assignedToId = request.user.id;
    }
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
    }
    if (locationId) where.locationId = locationId;
    if (priority) where.priority = priority;
    if (source) where.source = source;
    if (assignedToId) where.assignedToId = assignedToId;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from + 'T00:00:00Z');
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59Z');
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
        include: TICKET_INCLUDE
      }),
      prisma.ticket.count({ where })
    ]);

    // Count stats per status (org-wide, ignoring filters)
    const statsWhere = { orgId };
    if (request.user.role === 'SUPERVISOR') statsWhere.assignedToId = request.user.id;
    const statCounts = await prisma.ticket.groupBy({
      by: ['status'],
      where: statsWhere,
      _count: true
    });
    const stats = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 };
    for (const s of statCounts) stats[s.status] = s._count;

    return { tickets, total, page: Math.floor(skip / take) + 1, pages: Math.ceil(total / take), stats };
  });

  // ── Get single ticket ──
  fastify.get('/tickets/:id', async (request, reply) => {
    const { id } = request.params;
    const where = { id, orgId: request.user.orgId };
    if (request.user.role === 'SUPERVISOR') {
      where.assignedToId = request.user.id;
    }
    const ticket = await prisma.ticket.findFirst({ where, include: TICKET_INCLUDE });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    return ticket;
  });

  // ── Update ticket (Admin only): assign, change status/priority ──
  fastify.patch('/tickets/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
      assignedToId: z.string().uuid().optional().nullable(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional()
    });

    const data = schema.parse(request.body);

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId: request.user.orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });

    if (data.assignedToId) {
      const assignee = await prisma.user.findFirst({
        where: { id: data.assignedToId, orgId: request.user.orgId, role: 'SUPERVISOR', isActive: true }
      });
      if (!assignee) return reply.code(400).send({ error: 'Assignee not found or not a supervisor' });
    }

    const updateData = { ...data };
    if (data.status === 'RESOLVED' && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }
    if (data.status === 'CLOSED' && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: updateData,
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'ticket_updated',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status, assignedToId: ticket.assignedToId, priority: ticket.priority },
        newValue: data
      }
    });

    // Notify supervisor when ticket is assigned to them
    if (data.assignedToId && data.assignedToId !== ticket.assignedToId) {
      createNotification({
        orgId: request.user.orgId,
        userId: data.assignedToId,
        type: 'ticket_assigned',
        title: 'New ticket assigned to you',
        body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
        entityId: id
      }).catch(() => {});
    }

    return updated;
  });

  // ── Supervisor: Accept ticket (mark IN_PROGRESS) ──
  fastify.post('/tickets/:id/accept', {
    preHandler: [requireRole('SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const ticket = await prisma.ticket.findFirst({
      where: { id, orgId: request.user.orgId, assignedToId: request.user.id }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found or not assigned to you' });
    if (ticket.status !== 'OPEN') {
      return reply.code(400).send({ error: 'Only OPEN tickets can be accepted' });
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: { status: 'IN_PROGRESS' },
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'supervisor',
        actorId: request.user.id,
        action: 'ticket_accepted',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: 'OPEN' },
        newValue: { status: 'IN_PROGRESS' }
      }
    });

    return updated;
  });

  // ── Resolve ticket with proof photo (ADMIN or assigned SUPERVISOR) ──
  fastify.post('/tickets/:id/resolve', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });

    // Supervisors can only resolve tickets assigned to them
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only resolve tickets assigned to you' });
    }

    if (ticket.status === 'CLOSED') {
      return reply.code(400).send({ error: 'Ticket is already closed' });
    }

    let resolvedImageUrl = null;
    let resolvedNote = null;

    if (request.isMultipart()) {
      const fv = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };
      resolvedNote = fv(request.body.note)?.trim() || null;
      try { resolvedImageUrl = await processImage(request, orgId); } catch (e) {
        return reply.code(400).send({ error: e.message });
      }
    } else if (request.body) {
      resolvedNote = request.body.note?.trim() || null;
    }

    // Require proof photo for resolution
    if (!resolvedImageUrl) {
      return reply.code(400).send({ error: 'A proof photo is required to resolve tickets' });
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedImageUrl,
        resolvedNote
      },
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'ticket_resolved',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status },
        newValue: { status: 'RESOLVED', resolvedNote }
      }
    });

    // Notify admins that ticket was resolved
    notifyAdmins(orgId, {
      type: 'ticket_resolved',
      title: 'Ticket resolved',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    return updated;
  });
}

module.exports = ticketRoutes;
