'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const VALID_SHIFTS = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'];

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

async function dutyRosterRoutes(fastify) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Get my roster for a date/shift (Supervisor) ──
  fastify.get('/duty-roster/mine', async (request, reply) => {
    const orgId = request.user.orgId;
    const { date, shift } = request.query;

    if (!date || !isValidDateStr(date)) {
      return reply.code(400).send({ error: 'Valid date required (YYYY-MM-DD)' });
    }
    if (!shift || !VALID_SHIFTS.includes(shift)) {
      return reply.code(400).send({ error: 'Valid shift required' });
    }

    const dateObj = new Date(date + 'T00:00:00Z');

    const roster = await prisma.dutyRoster.findFirst({
      where: { orgId, date: dateObj, shift, supervisorId: request.user.id },
      include: {
        location: {
          select: { id: true, name: true, type: true, parent: { select: { id: true, name: true } } }
        },
        workers: {
          include: {
            worker: { select: { id: true, name: true, employeeId: true, isActive: true } }
          },
          orderBy: { worker: { name: 'asc' } }
        }
      }
    });

    return roster;
  });

  // ── List rosters for a date (Admin: all, Supervisor: own) ──
  fastify.get('/duty-roster', async (request) => {
    const orgId = request.user.orgId;
    const { date, shift, locationId } = request.query;

    const where = { orgId };
    if (date && isValidDateStr(date)) where.date = new Date(date + 'T00:00:00Z');
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;
    if (locationId) where.locationId = locationId;

    // Supervisors only see their own rosters
    if (request.user.role === 'SUPERVISOR') {
      where.supervisorId = request.user.id;
    }

    const rosters = await prisma.dutyRoster.findMany({
      where,
      include: {
        location: {
          select: { id: true, name: true, type: true, parent: { select: { name: true } } }
        },
        supervisor: { select: { id: true, name: true } },
        _count: { select: { workers: true } }
      },
      orderBy: [{ date: 'desc' }, { shift: 'asc' }]
    });

    return { rosters };
  });

  // ── Create roster (Supervisor assigns self to location) ──
  fastify.post('/duty-roster', async (request, reply) => {
    const orgId = request.user.orgId;

    const schema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      shift: z.enum(VALID_SHIFTS),
      locationId: z.string().uuid()
    });

    const data = schema.parse(request.body);

    if (!isValidDateStr(data.date)) {
      return reply.code(400).send({ error: 'Invalid date' });
    }

    // Only allow today or yesterday for supervisors
    const dateObj = new Date(data.date + 'T00:00:00Z');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (request.user.role !== 'ADMIN' && dateObj < yesterday) {
      return reply.code(400).send({ error: 'Can only create rosters for today or yesterday' });
    }

    // Validate location belongs to org
    const location = await prisma.location.findFirst({
      where: { id: data.locationId, orgId, isActive: true }
    });
    if (!location) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    // Check if supervisor already has a roster for this date/shift
    const existing = await prisma.dutyRoster.findFirst({
      where: { orgId, date: dateObj, shift: data.shift, supervisorId: request.user.id }
    });
    if (existing) {
      return reply.code(409).send({
        error: 'You already have a roster for this shift. Use the change option instead.',
        rosterId: existing.id
      });
    }

    const roster = await prisma.dutyRoster.create({
      data: {
        orgId,
        date: dateObj,
        shift: data.shift,
        locationId: data.locationId,
        supervisorId: request.user.id
      },
      include: {
        location: {
          select: { id: true, name: true, type: true, parent: { select: { id: true, name: true } } }
        },
        workers: true
      }
    });

    return roster;
  });

  // ── Update roster location (change floor) ──
  fastify.patch('/duty-roster/:id', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const roster = await prisma.dutyRoster.findFirst({ where: { id, orgId } });
    if (!roster) return reply.code(404).send({ error: 'Roster not found' });

    // Only own rosters for supervisors
    if (request.user.role === 'SUPERVISOR' && roster.supervisorId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your roster' });
    }

    const schema = z.object({ locationId: z.string().uuid() });
    const data = schema.parse(request.body);

    const location = await prisma.location.findFirst({
      where: { id: data.locationId, orgId, isActive: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    const updated = await prisma.dutyRoster.update({
      where: { id },
      data: { locationId: data.locationId },
      include: {
        location: {
          select: { id: true, name: true, type: true, parent: { select: { id: true, name: true } } }
        },
        workers: {
          include: { worker: { select: { id: true, name: true, employeeId: true, isActive: true } } },
          orderBy: { worker: { name: 'asc' } }
        }
      }
    });

    return updated;
  });

  // ── Update workers in roster ──
  fastify.put('/duty-roster/:id/workers', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const roster = await prisma.dutyRoster.findFirst({ where: { id, orgId } });
    if (!roster) return reply.code(404).send({ error: 'Roster not found' });

    if (request.user.role === 'SUPERVISOR' && roster.supervisorId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your roster' });
    }

    const schema = z.object({
      workerIds: z.array(z.string().uuid()).max(200)
    });
    const data = schema.parse(request.body);

    // Validate workers belong to org and are active
    if (data.workerIds.length > 0) {
      const workers = await prisma.worker.findMany({
        where: { id: { in: data.workerIds }, orgId, isActive: true },
        select: { id: true }
      });
      if (workers.length !== new Set(data.workerIds).size) {
        return reply.code(400).send({ error: 'One or more workers not found or inactive' });
      }
    }

    // Replace all roster workers in a transaction
    await prisma.$transaction([
      prisma.dutyRosterWorker.deleteMany({ where: { rosterId: id } }),
      ...(data.workerIds.length > 0
        ? [prisma.dutyRosterWorker.createMany({
            data: data.workerIds.map(wId => ({ rosterId: id, workerId: wId }))
          })]
        : [])
    ]);

    // Return updated roster
    const updated = await prisma.dutyRoster.findFirst({
      where: { id },
      include: {
        location: {
          select: { id: true, name: true, type: true, parent: { select: { id: true, name: true } } }
        },
        workers: {
          include: { worker: { select: { id: true, name: true, employeeId: true, isActive: true } } },
          orderBy: { worker: { name: 'asc' } }
        }
      }
    });

    return updated;
  });

  // ── Get suggested workers for a location (from WorkerAssignment defaults) ──
  fastify.get('/duty-roster/suggested-workers', async (request, reply) => {
    const orgId = request.user.orgId;
    const { locationId } = request.query;

    if (!locationId) {
      return reply.code(400).send({ error: 'locationId required' });
    }

    // Get workers assigned to this location via WorkerAssignment (admin defaults)
    const assigned = await prisma.workerAssignment.findMany({
      where: { locationId, orgId },
      include: {
        worker: { select: { id: true, name: true, employeeId: true, isActive: true } }
      }
    });
    const suggested = assigned
      .filter(a => a.worker.isActive)
      .map(a => a.worker);

    // Also get ALL active workers for the "add more" list
    const allWorkers = await prisma.worker.findMany({
      where: { orgId, isActive: true },
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: 'asc' }
    });

    return {
      suggested,
      allWorkers
    };
  });

  // ── Get locations with roster data for a date (for admin floor dropdown) ──
  fastify.get('/duty-roster/locations', async (request) => {
    const orgId = request.user.orgId;
    const { date, shift } = request.query;

    const where = { orgId };
    if (date && isValidDateStr(date)) where.date = new Date(date + 'T00:00:00Z');
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;

    const rosters = await prisma.dutyRoster.findMany({
      where,
      select: {
        locationId: true,
        location: {
          select: { id: true, name: true, type: true, parent: { select: { name: true } } }
        },
        supervisor: { select: { name: true } },
        _count: { select: { workers: true } }
      },
      distinct: ['locationId']
    });

    return {
      floors: rosters.map(r => ({
        id: r.location.id,
        name: r.location.name,
        type: r.location.type,
        parentName: r.location.parent?.name || null,
        supervisorName: r.supervisor.name,
        workerCount: r._count.workers
      }))
    };
  });

  // ── Delete roster (admin only, or supervisor own) ──
  fastify.delete('/duty-roster/:id', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const roster = await prisma.dutyRoster.findFirst({ where: { id, orgId } });
    if (!roster) return reply.code(404).send({ error: 'Roster not found' });

    if (request.user.role === 'SUPERVISOR' && roster.supervisorId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your roster' });
    }

    await prisma.dutyRoster.delete({ where: { id } });
    return { success: true };
  });
}

module.exports = dutyRosterRoutes;
