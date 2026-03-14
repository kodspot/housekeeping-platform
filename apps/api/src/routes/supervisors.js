'use strict';

const bcrypt = require('bcrypt');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST } = require('../lib/security');
const { authenticateJWT, requireRole } = require('../middleware/auth');

async function supervisorRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN'));

  // List supervisors — with search, filter, sort, pagination
  fastify.get('/supervisors', async (request) => {
    const { active, search, sort, page, limit } = request.query;
    const orgId = request.user.orgId;
    const where = { orgId, role: 'SUPERVISOR' };
    if (active !== undefined) where.isActive = active === 'true';

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } }
      ];
    }

    const sortMap = {
      'name': { name: 'asc' },
      'name-desc': { name: 'desc' },
      'records': { cleaningRecords: { _count: 'desc' } },
      'newest': { createdAt: 'desc' },
      'oldest': { createdAt: 'asc' }
    };
    const orderBy = sortMap[sort] || { name: 'asc' };

    const pageNum = Math.max(1, parseInt(page) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip = (pageNum - 1) * take;

    const select = {
      id: true, name: true, email: true, phone: true, designation: true,
      employeeId: true, department: true, gender: true, bloodGroup: true,
      dateOfBirth: true, dateOfJoin: true, address: true, aadharNo: true, notes: true,
      isActive: true, createdAt: true,
      _count: { select: { cleaningRecords: true, ticketsAssigned: true } }
    };

    const [supervisors, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy, select, skip, take }),
      prisma.user.count({ where })
    ]);

    return {
      supervisors,
      page: pageNum,
      limit: take,
      total,
      totalPages: Math.ceil(total / take)
    };
  });

  // Get single supervisor (for View Detail / Edit)
  fastify.get('/supervisors/:id', async (request, reply) => {
    const { id } = request.params;
    const user = await prisma.user.findFirst({
      where: { id, orgId: request.user.orgId, role: 'SUPERVISOR' },
      select: {
        id: true, name: true, email: true, phone: true, designation: true,
        employeeId: true, department: true, gender: true, bloodGroup: true,
        dateOfBirth: true, dateOfJoin: true, address: true, aadharNo: true, notes: true,
        isActive: true, createdAt: true, updatedAt: true,
        _count: { select: { cleaningRecords: true, ticketsAssigned: true } }
      }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });
    return user;
  });

  // Create supervisor
  fastify.post('/supervisors', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      phone: z.string().max(20).optional().or(z.literal('')),
      designation: z.string().max(100).optional().or(z.literal('')),
      employeeId: z.string().max(50).optional().or(z.literal('')),
      department: z.string().max(100).optional().or(z.literal('')),
      gender: z.enum(['Male','Female','Other']).optional().or(z.literal('')),
      bloodGroup: z.string().max(10).optional().or(z.literal('')),
      dateOfBirth: z.string().optional().or(z.literal('')),
      dateOfJoin: z.string().optional().or(z.literal('')),
      address: z.string().max(500).optional().or(z.literal('')),
      aadharNo: z.string().max(20).optional().or(z.literal('')),
      notes: z.string().max(1000).optional().or(z.literal('')),
      password: z.string().min(8).max(100)
    });

    const data = schema.parse(request.body);
    const normalizedEmail = data.email.toLowerCase().trim();
    const orgId = request.user.orgId;

    const existing = await prisma.user.findUnique({
      where: { orgId_email: { orgId, email: normalizedEmail } }
    });
    if (existing) return reply.code(409).send({ error: 'A user with this email already exists' });

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

    const supervisor = await prisma.user.create({
      data: {
        orgId,
        name: data.name,
        email: normalizedEmail,
        phone: data.phone || null,
        designation: data.designation || null,
        employeeId: data.employeeId || null,
        department: data.department || null,
        gender: data.gender || null,
        bloodGroup: data.bloodGroup || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        dateOfJoin: data.dateOfJoin ? new Date(data.dateOfJoin) : null,
        address: data.address || null,
        aadharNo: data.aadharNo || null,
        notes: data.notes || null,
        passwordHash,
        role: 'SUPERVISOR'
      },
      select: { id: true, name: true, email: true, phone: true, designation: true, role: true, createdAt: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'supervisor_created',
        entityType: 'User',
        entityId: supervisor.id,
        newValue: { name: supervisor.name, email: supervisor.email }
      }
    });

    return supervisor;
  });

  // Update supervisor — with audit logging
  fastify.patch('/supervisors/:id', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional().nullable().or(z.literal('')),
      designation: z.string().max(100).optional().nullable().or(z.literal('')),
      employeeId: z.string().max(50).optional().nullable().or(z.literal('')),
      department: z.string().max(100).optional().nullable().or(z.literal('')),
      gender: z.enum(['Male','Female','Other']).optional().nullable().or(z.literal('')),
      bloodGroup: z.string().max(10).optional().nullable().or(z.literal('')),
      dateOfBirth: z.string().optional().nullable().or(z.literal('')),
      dateOfJoin: z.string().optional().nullable().or(z.literal('')),
      address: z.string().max(500).optional().nullable().or(z.literal('')),
      aadharNo: z.string().max(20).optional().nullable().or(z.literal('')),
      notes: z.string().max(1000).optional().nullable().or(z.literal('')),
      isActive: z.boolean().optional()
    });

    const data = schema.parse(request.body);
    const orgId = request.user.orgId;

    // Normalize empty strings to null
    if (data.phone === '') data.phone = null;
    if (data.designation === '') data.designation = null;
    if (data.employeeId === '') data.employeeId = null;
    if (data.department === '') data.department = null;
    if (data.gender === '') data.gender = null;
    if (data.bloodGroup === '') data.bloodGroup = null;
    if (data.address === '') data.address = null;
    if (data.aadharNo === '') data.aadharNo = null;
    if (data.notes === '') data.notes = null;
    // Convert date strings to Date objects
    if (data.dateOfBirth === '') data.dateOfBirth = null;
    else if (data.dateOfBirth) data.dateOfBirth = new Date(data.dateOfBirth);
    if (data.dateOfJoin === '') data.dateOfJoin = null;
    else if (data.dateOfJoin) data.dateOfJoin = new Date(data.dateOfJoin);

    const user = await prisma.user.findFirst({
      where: { id, orgId, role: 'SUPERVISOR' }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true, designation: true, isActive: true }
    });

    // Audit log — track changes
    const changes = {};
    for (const key of Object.keys(data)) {
      if (data[key] !== user[key]) changes[key] = { from: user[key], to: data[key] };
    }
    if (Object.keys(changes).length > 0) {
      await prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'admin',
          actorId: request.user.id,
          action: data.isActive === false ? 'supervisor_deactivated' : data.isActive === true ? 'supervisor_reactivated' : 'supervisor_updated',
          entityType: 'User',
          entityId: id,
          oldValue: { name: user.name, email: user.email },
          newValue: changes
        }
      });
    }

    return updated;
  });

  // Reset supervisor password
  fastify.patch('/supervisors/:id/password', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      password: z.string().min(8).max(100)
    });

    const { password } = schema.parse(request.body);

    const user = await prisma.user.findFirst({
      where: { id, orgId: request.user.orgId, role: 'SUPERVISOR' }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await prisma.user.update({ where: { id }, data: { passwordHash } });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'supervisor_password_reset',
        entityType: 'User',
        entityId: id
      }
    });

    return { success: true, message: 'Password updated' };
  });

  // Deactivate supervisor (kept for API compatibility)
  fastify.delete('/supervisors/:id', async (request, reply) => {
    const { id } = request.params;

    const user = await prisma.user.findFirst({
      where: { id, orgId: request.user.orgId, role: 'SUPERVISOR' }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });

    await prisma.user.update({ where: { id }, data: { isActive: false } });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'supervisor_deactivated',
        entityType: 'User',
        entityId: id,
        oldValue: { name: user.name }
      }
    });

    return { success: true, message: 'Supervisor deactivated' };
  });

  // Supervisor stats — enriched with flagged, tickets, shifts, top locations, late submissions
  fastify.get('/supervisors/:id/stats', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;
    const user = await prisma.user.findFirst({
      where: { id, orgId, role: 'SUPERVISOR' }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);
    const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const base = { supervisorId: id };
    const [daily, weekly, monthly, yearly, total, flagged, lateCount, lastRecord, shiftRecords, locationRecords, ticketsAssigned, ticketsResolved, ticketsOpen] = await Promise.all([
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: today } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: weekAgo } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: monthAgo } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: yearAgo } } }),
      prisma.cleaningRecord.count({ where: base }),
      prisma.cleaningRecord.count({ where: { ...base, status: 'FLAGGED' } }),
      prisma.cleaningRecord.count({ where: { ...base, isLate: true } }),
      prisma.cleaningRecord.findFirst({ where: base, orderBy: { cleanedAt: 'desc' }, select: { cleanedAt: true } }),
      prisma.cleaningRecord.groupBy({ by: ['shift'], where: base, _count: true }),
      prisma.cleaningRecord.groupBy({ by: ['locationId'], where: base, _count: true, orderBy: { _count: { locationId: 'desc' } }, take: 5 }),
      prisma.ticket.count({ where: { assignedToId: id } }),
      prisma.ticket.count({ where: { assignedToId: id, status: { in: ['RESOLVED', 'CLOSED'] } } }),
      prisma.ticket.count({ where: { assignedToId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } } })
    ]);

    // Resolve location names
    const locIds = locationRecords.map(r => r.locationId);
    const locations = locIds.length ? await prisma.location.findMany({
      where: { id: { in: locIds } },
      select: { id: true, name: true }
    }) : [];
    const locMap = {};
    for (const l of locations) locMap[l.id] = l.name;

    const shifts = {};
    for (const r of shiftRecords) shifts[r.shift] = r._count;

    const topLocations = locationRecords.map(r => ({
      name: locMap[r.locationId] || 'Unknown',
      count: r._count
    }));

    return {
      daily, weekly, monthly, yearly, total,
      flagged, lateCount,
      lastActivity: lastRecord ? lastRecord.cleanedAt : null,
      shifts,
      topLocations,
      tickets: { assigned: ticketsAssigned, resolved: ticketsResolved, open: ticketsOpen }
    };
  });

  // Permanent delete supervisor (must be deactivated first, no cleaning records)
  fastify.delete('/supervisors/:id/permanent', async (request, reply) => {
    const { id } = request.params;
    const user = await prisma.user.findFirst({
      where: { id, orgId: request.user.orgId, role: 'SUPERVISOR' }
    });
    if (!user) return reply.code(404).send({ error: 'Supervisor not found' });
    if (user.isActive) {
      return reply.code(400).send({ error: 'Supervisor must be deactivated before permanent deletion' });
    }

    const recordCount = await prisma.cleaningRecord.count({ where: { supervisorId: id } });
    if (recordCount > 0) {
      return reply.code(409).send({
        error: 'Cannot permanently delete supervisor with ' + recordCount + ' cleaning records. They will remain archived.',
        cleaningRecords: recordCount
      });
    }

    await prisma.user.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'supervisor_deleted_permanent',
        entityType: 'User',
        entityId: id,
        oldValue: { name: user.name, email: user.email }
      }
    });

    return { success: true, message: 'Supervisor permanently deleted' };
  });
}

module.exports = supervisorRoutes;
