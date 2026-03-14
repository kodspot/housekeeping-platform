'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { APP_URL } = require('../config/env');

const LOCATION_TYPES = ['BUILDING', 'FLOOR', 'ROOM', 'CORRIDOR', 'WASHROOM', 'ICU', 'LOBBY', 'KITCHEN', 'WARD', 'MEETING_ROOM', 'OTHER'];

// Generate 8-char alphanumeric QR code
async function generateUniqueQrCode(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = crypto.randomBytes(6).toString('base64url').substring(0, 8).toUpperCase();
    const existing = await prisma.location.findUnique({ where: { qrCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique QR code');
}

async function locationRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);

  // List locations (flat or tree)
  fastify.get('/locations', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { tree, parentId, type, active } = request.query;

    const where = { orgId };
    if (parentId !== undefined) where.parentId = parentId || null;
    if (type) where.type = type;
    if (active !== undefined) where.isActive = active === 'true';

    const locations = await prisma.location.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        children: tree === 'true' ? {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            children: {
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
            }
          }
        } : false,
        cleaningSchedules: true,
        _count: { select: { cleaningRecords: true, tickets: true } }
      }
    });

    if (tree === 'true' && parentId === undefined) {
      return locations.filter(l => l.parentId === null);
    }

    return locations;
  });

  // Get single location
  fastify.get('/locations/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const location = await prisma.location.findFirst({
      where: { id, orgId: request.user.orgId },
      include: {
        children: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        parent: { select: { id: true, name: true, type: true } },
        cleaningSchedules: true
      }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found' });
    return location;
  });

  // Resolve QR code → location (used by supervisor scan)
  fastify.get('/locations/qr/:code', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const code = request.params.code.toUpperCase().trim();
    const location = await prisma.location.findUnique({
      where: { qrCode: code },
      include: {
        parent: { select: { id: true, name: true, type: true } },
        cleaningSchedules: true
      }
    });
    if (!location || location.orgId !== request.user.orgId) {
      return reply.code(404).send({ error: 'Location not found' });
    }
    if (!location.isActive) {
      return reply.code(410).send({ error: 'Location is deactivated' });
    }
    return location;
  });

  // Generate QR image (SVG) for printing
  fastify.get('/locations/:id/qr-image', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const location = await prisma.location.findFirst({
      where: { id, orgId: request.user.orgId },
      select: { qrCode: true, name: true, type: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    const qrData = `${APP_URL}/scan/${location.qrCode}`;
    const svg = await QRCode.toString(qrData, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#1e293b', light: '#ffffff' }
    });

    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=86400');
    return svg;
  });

  // Create location (Admin only)
  fastify.post('/locations', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(200).trim(),
      type: z.enum(LOCATION_TYPES),
      parentId: z.string().uuid().optional().nullable(),
      sortOrder: z.number().int().default(0),
      notes: z.string().max(500).optional()
    });

    const data = schema.parse(request.body);
    const orgId = request.user.orgId;

    if (data.parentId) {
      const parent = await prisma.location.findFirst({ where: { id: data.parentId, orgId } });
      if (!parent) return reply.code(400).send({ error: 'Parent location not found' });
    }

    const qrCode = await generateUniqueQrCode();

    const location = await prisma.location.create({
      data: { ...data, orgId, qrCode },
      include: { parent: { select: { id: true, name: true, type: true } } }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'location_created',
        entityType: 'Location',
        entityId: location.id,
        newValue: { name: data.name, type: data.type, qrCode }
      }
    });

    return location;
  });

  // Update location (Admin only)
  fastify.patch('/locations/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).max(200).trim().optional(),
      type: z.enum(LOCATION_TYPES).optional(),
      parentId: z.string().uuid().optional().nullable(),
      sortOrder: z.number().int().optional(),
      notes: z.string().max(500).optional(),
      isActive: z.boolean().optional()
    });

    const data = schema.parse(request.body);
    const orgId = request.user.orgId;

    const existing = await prisma.location.findFirst({ where: { id, orgId } });
    if (!existing) return reply.code(404).send({ error: 'Location not found' });

    if (data.parentId) {
      if (data.parentId === id) return reply.code(400).send({ error: 'Location cannot be its own parent' });
      const parent = await prisma.location.findFirst({ where: { id: data.parentId, orgId } });
      if (!parent) return reply.code(400).send({ error: 'Parent location not found' });
      // Prevent circular references — walk up from proposed parent to root
      let cursor = parent;
      const visited = new Set([id]);
      while (cursor && cursor.parentId) {
        if (visited.has(cursor.parentId)) return reply.code(400).send({ error: 'Circular reference detected' });
        visited.add(cursor.parentId);
        cursor = await prisma.location.findFirst({ where: { id: cursor.parentId, orgId }, select: { id: true, parentId: true } });
      }
    }

    const updated = await prisma.location.update({ where: { id }, data });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'location_updated',
        entityType: 'Location',
        entityId: id,
        oldValue: { name: existing.name, type: existing.type },
        newValue: data
      }
    });

    return updated;
  });

  // Deactivate location (Admin only) — with dependency check
  fastify.delete('/locations/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const { force } = request.query;
    const orgId = request.user.orgId;

    const location = await prisma.location.findFirst({ where: { id, orgId } });
    if (!location) return reply.code(404).send({ error: 'Location not found' });
    if (!location.isActive) return reply.code(400).send({ error: 'Location is already deactivated' });

    // Check dependencies
    const [childCount, cleaningCount, ticketCount] = await Promise.all([
      prisma.location.count({ where: { parentId: id } }),
      prisma.cleaningRecord.count({ where: { locationId: id } }),
      prisma.ticket.count({ where: { locationId: id } })
    ]);

    if ((childCount > 0 || cleaningCount > 0 || ticketCount > 0) && force !== 'true') {
      return reply.code(409).send({
        error: 'Location has dependencies',
        dependencies: { children: childCount, cleaningRecords: cleaningCount, tickets: ticketCount }
      });
    }

    await prisma.location.update({ where: { id }, data: { isActive: false } });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'location_deactivated',
        entityType: 'Location',
        entityId: id
      }
    });

    return { success: true, message: 'Location deactivated' };
  });

  // === Cleaning Schedules ===

  fastify.get('/locations/:id/schedule', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schedule = await prisma.cleaningSchedule.findUnique({
      where: { locationId: id },
      include: { location: { select: { id: true, name: true, type: true } } }
    });
    if (!schedule || schedule.orgId !== request.user.orgId) {
      return reply.code(404).send({ error: 'No schedule found for this location' });
    }
    return schedule;
  });

  fastify.put('/locations/:id/schedule', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const location = await prisma.location.findFirst({ where: { id, orgId } });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    const schema = z.object({
      frequency: z.enum(['ONCE_DAILY', 'TWICE_DAILY', 'THRICE_DAILY', 'WEEKLY', 'CUSTOM']),
      shifts: z.array(z.enum(['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'])).min(1),
      notes: z.string().max(500).optional(),
      isActive: z.boolean().default(true)
    });

    const data = schema.parse(request.body);

    const schedule = await prisma.cleaningSchedule.upsert({
      where: { locationId: id },
      create: { orgId, locationId: id, ...data },
      update: data,
      include: { location: { select: { id: true, name: true, type: true } } }
    });

    return schedule;
  });

  // Full location hierarchy as a tree for admin UI
  fastify.get('/locations/tree', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { active } = request.query;

    const where = { orgId };
    if (active !== undefined) where.isActive = active === 'true';

    const allLocations = await prisma.location.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, type: true, parentId: true,
        qrCode: true, sortOrder: true, isActive: true, notes: true,
        cleaningSchedules: { select: { frequency: true, shifts: true, isActive: true } },
        _count: {
          select: {
            cleaningRecords: true,
            tickets: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
            children: true
          }
        }
      }
    });

    // Build tree in-memory — O(n) with a map
    const nodeMap = new Map();
    for (const loc of allLocations) {
      nodeMap.set(loc.id, { ...loc, schedule: loc.cleaningSchedules[0] || null, children: [] });
    }

    const roots = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }

    // Clean up: remove the flat cleaningSchedules array (already in .schedule)
    function clean(node) {
      delete node.cleaningSchedules;
      for (const child of node.children) clean(child);
      return node;
    }

    return roots.map(clean);
  });
}

module.exports = locationRoutes;
