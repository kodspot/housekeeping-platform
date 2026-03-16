'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const VALID_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY'];
const VALID_SHIFTS = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'];

async function attendanceRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Get attendance for a date/shift/location ──
  // Returns all workers assigned to that location with their attendance status
  fastify.get('/attendance', async (request, reply) => {
    const orgId = request.user.orgId;
    const { date, shift, locationId } = request.query;

    if (!date) {
      return reply.code(400).send({ error: 'date query parameter is required (YYYY-MM-DD)' });
    }

    const dateObj = new Date(date + 'T00:00:00Z');
    const where = { orgId, date: dateObj };
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;

    // If locationId provided, get workers assigned to that location
    let assignedWorkerIds = null;
    if (locationId) {
      const assignments = await prisma.workerAssignment.findMany({
        where: { locationId, orgId },
        select: { workerId: true }
      });
      assignedWorkerIds = assignments.map(a => a.workerId);

      // Also filter attendance to only these workers
      if (assignedWorkerIds.length > 0) {
        where.workerId = { in: assignedWorkerIds };
      }
    }

    // Get existing attendance records
    const records = await prisma.attendance.findMany({
      where,
      include: {
        worker: { select: { id: true, name: true, employeeId: true, isActive: true } },
        markedBy: { select: { id: true, name: true } }
      },
      orderBy: { worker: { name: 'asc' } }
    });

    // Get all workers that should appear (assigned to location or all active workers)
    let allWorkers;
    if (assignedWorkerIds && assignedWorkerIds.length > 0) {
      allWorkers = await prisma.worker.findMany({
        where: { id: { in: assignedWorkerIds }, orgId, isActive: true },
        select: { id: true, name: true, employeeId: true, isActive: true },
        orderBy: { name: 'asc' }
      });
    } else if (!locationId) {
      // No location filter — get all active workers
      allWorkers = await prisma.worker.findMany({
        where: { orgId, isActive: true },
        select: { id: true, name: true, employeeId: true, isActive: true },
        orderBy: { name: 'asc' }
      });
    } else {
      allWorkers = [];
    }

    // Merge: workers with records + workers without records (unmarked)
    const result = [];
    const recordMap = {};
    for (const r of records) {
      recordMap[r.workerId] = r;
    }

    for (const w of allWorkers) {
      if (recordMap[w.id]) {
        const r = recordMap[w.id];
        result.push({
          attendanceId: r.id,
          worker: w,
          status: r.status,
          shift: r.shift,
          note: r.note,
          markedBy: r.markedBy,
          createdAt: r.createdAt
        });
      } else {
        result.push({
          attendanceId: null,
          worker: w,
          status: null,
          shift: shift || null,
          note: null,
          markedBy: null,
          createdAt: null
        });
      }
    }

    // Also add records for workers not in the allWorkers list (edge case: unassigned but marked)
    for (const r of records) {
      if (!allWorkers.find(w => w.id === r.workerId)) {
        result.push({
          attendanceId: r.id,
          worker: r.worker,
          status: r.status,
          shift: r.shift,
          note: r.note,
          markedBy: r.markedBy,
          createdAt: r.createdAt
        });
      }
    }

    // Summary stats
    let present = 0, absent = 0, leave = 0, halfDay = 0, unmarked = 0;
    for (const r of result) {
      if (!r.status) unmarked++;
      else if (r.status === 'PRESENT') present++;
      else if (r.status === 'ABSENT') absent++;
      else if (r.status === 'LEAVE') leave++;
      else if (r.status === 'HALF_DAY') halfDay++;
    }

    return {
      records: result,
      summary: { present, absent, leave, halfDay, unmarked, total: result.length }
    };
  });

  // ── Bulk mark attendance (create or update) ──
  fastify.post('/attendance/bulk', async (request, reply) => {
    const orgId = request.user.orgId;

    const schema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      shift: z.enum(VALID_SHIFTS),
      records: z.array(z.object({
        workerId: z.string().uuid(),
        status: z.enum(VALID_STATUSES),
        note: z.string().max(500).optional().nullable()
      })).min(1).max(200)
    });

    const data = schema.parse(request.body);

    // Only allow today or yesterday (admins can override)
    const dateObj = new Date(data.date + 'T00:00:00Z');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (request.user.role !== 'ADMIN') {
      if (dateObj < yesterday) {
        return reply.code(400).send({ error: 'Supervisors can only mark attendance for today or yesterday' });
      }
    }

    // Validate all workers belong to org and are active
    const workerIds = data.records.map(r => r.workerId);
    const workers = await prisma.worker.findMany({
      where: { id: { in: workerIds }, orgId, isActive: true },
      select: { id: true }
    });
    if (workers.length !== new Set(workerIds).size) {
      return reply.code(400).send({ error: 'One or more workers not found or inactive' });
    }

    // Upsert each record
    const results = [];
    for (const rec of data.records) {
      const upserted = await prisma.attendance.upsert({
        where: {
          workerId_date_shift: {
            workerId: rec.workerId,
            date: dateObj,
            shift: data.shift
          }
        },
        create: {
          orgId,
          workerId: rec.workerId,
          markedById: request.user.id,
          date: dateObj,
          shift: data.shift,
          status: rec.status,
          note: rec.note?.trim() || null
        },
        update: {
          status: rec.status,
          note: rec.note?.trim() || null,
          markedById: request.user.id
        }
      });
      results.push(upserted);
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'attendance_marked',
        entityType: 'Attendance',
        newValue: { date: data.date, shift: data.shift, count: data.records.length }
      }
    });

    return { success: true, count: results.length };
  });

  // ── Update single attendance record ──
  fastify.patch('/attendance/:id', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      status: z.enum(VALID_STATUSES).optional(),
      note: z.string().max(500).optional().nullable()
    });

    const data = schema.parse(request.body);

    const record = await prisma.attendance.findFirst({ where: { id, orgId } });
    if (!record) return reply.code(404).send({ error: 'Attendance record not found' });

    // Supervisors can only edit their own markings
    if (request.user.role === 'SUPERVISOR' && record.markedById !== request.user.id) {
      return reply.code(403).send({ error: 'You can only edit attendance you marked' });
    }

    const updateData = {};
    if (data.status) updateData.status = data.status;
    if (data.note !== undefined) updateData.note = data.note?.trim() || null;
    updateData.markedById = request.user.id;

    const updated = await prisma.attendance.update({
      where: { id },
      data: updateData,
      include: {
        worker: { select: { id: true, name: true, employeeId: true } },
        markedBy: { select: { id: true, name: true } }
      }
    });

    return updated;
  });

  // ── Attendance report (aggregated stats) ──
  fastify.get('/attendance/report', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to, workerId, locationId, shift } = request.query;

    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to date parameters required (YYYY-MM-DD)' });
    }

    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');

    const where = {
      orgId,
      date: { gte: fromDate, lte: toDate }
    };
    if (workerId) where.workerId = workerId;
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;

    // If locationId, filter by workers assigned to that location
    if (locationId) {
      const assignments = await prisma.workerAssignment.findMany({
        where: { locationId, orgId },
        select: { workerId: true }
      });
      where.workerId = { in: assignments.map(a => a.workerId) };
    }

    // Get all records
    const records = await prisma.attendance.findMany({
      where,
      include: {
        worker: { select: { id: true, name: true, employeeId: true } }
      },
      orderBy: [{ date: 'asc' }, { worker: { name: 'asc' } }]
    });

    // Aggregate per worker
    const workerStats = {};
    for (const r of records) {
      if (!workerStats[r.workerId]) {
        workerStats[r.workerId] = {
          worker: r.worker,
          present: 0, absent: 0, leave: 0, halfDay: 0, total: 0
        };
      }
      const s = workerStats[r.workerId];
      s.total++;
      if (r.status === 'PRESENT') s.present++;
      else if (r.status === 'ABSENT') s.absent++;
      else if (r.status === 'LEAVE') s.leave++;
      else if (r.status === 'HALF_DAY') s.halfDay++;
    }

    // Calculate percentages
    const workerSummaries = Object.values(workerStats).map(s => ({
      ...s,
      attendancePercent: s.total > 0 ? Math.round(((s.present + s.halfDay * 0.5) / s.total) * 100) : 0
    }));
    workerSummaries.sort((a, b) => a.worker.name.localeCompare(b.worker.name));

    // Overall summary
    let totalPresent = 0, totalAbsent = 0, totalLeave = 0, totalHalfDay = 0, totalRecords = 0;
    for (const s of workerSummaries) {
      totalPresent += s.present;
      totalAbsent += s.absent;
      totalLeave += s.leave;
      totalHalfDay += s.halfDay;
      totalRecords += s.total;
    }

    return {
      workers: workerSummaries,
      summary: {
        totalRecords,
        present: totalPresent,
        absent: totalAbsent,
        leave: totalLeave,
        halfDay: totalHalfDay,
        attendancePercent: totalRecords > 0 ? Math.round(((totalPresent + totalHalfDay * 0.5) / totalRecords) * 100) : 0
      },
      dateRange: { from, to }
    };
  });

  // ── Today's attendance overview (for dashboard) ──
  fastify.get('/attendance/today', async (request) => {
    const orgId = request.user.orgId;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const records = await prisma.attendance.groupBy({
      by: ['status'],
      where: { orgId, date: today },
      _count: true
    });

    const totalWorkers = await prisma.worker.count({ where: { orgId, isActive: true } });

    const stats = { present: 0, absent: 0, leave: 0, halfDay: 0, marked: 0 };
    for (const r of records) {
      stats[r.status === 'HALF_DAY' ? 'halfDay' : r.status.toLowerCase()] = r._count;
      stats.marked += r._count;
    }
    stats.unmarked = Math.max(0, totalWorkers - stats.marked);
    stats.totalWorkers = totalWorkers;

    return stats;
  });

  // ── Floors with assigned workers (for supervisor dropdown) ──
  fastify.get('/attendance/floors', async (request) => {
    const orgId = request.user.orgId;

    // Get all location IDs that have worker assignments
    const assignments = await prisma.workerAssignment.findMany({
      where: { orgId },
      select: { locationId: true },
      distinct: ['locationId']
    });

    const locationIds = assignments.map(a => a.locationId);
    if (locationIds.length === 0) return { floors: [] };

    const locations = await prisma.location.findMany({
      where: { id: { in: locationIds }, orgId, isActive: true },
      select: {
        id: true,
        name: true,
        type: true,
        parent: { select: { name: true } },
        _count: { select: { workerAssignments: true } }
      },
      orderBy: [{ parent: { name: 'asc' } }, { name: 'asc' }]
    });

    return {
      floors: locations.map(l => ({
        id: l.id,
        name: l.name,
        type: l.type,
        parentName: l.parent?.name || null,
        workerCount: l._count.workerAssignments
      }))
    };
  });
}

module.exports = attendanceRoutes;
