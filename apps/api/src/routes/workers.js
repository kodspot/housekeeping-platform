'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { encryptWorkerPII, decryptWorkerPII } = require('../lib/crypto');

async function workerRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);

  // List workers — with search, department filter, sort, pagination
  fastify.get('/workers', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const { active, search, department, sort, page, limit } = request.query;
    const orgId = request.user.orgId;
    const where = { orgId };

    if (active !== undefined) where.isActive = active === 'true';
    if (department) where.department = department;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { employeeId: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Sort options
    const sortMap = {
      'name': { name: 'asc' },
      'name-desc': { name: 'desc' },
      'newest': { createdAt: 'desc' },
      'oldest': { createdAt: 'asc' },
      'dept': { department: 'asc' },
      'cleanings': undefined // handled after fetch
    };
    const orderBy = sortMap[sort] || { name: 'asc' };

    const pageNum = Math.max(1, parseInt(page) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip = (pageNum - 1) * take;

    const select = {
      id: true, employeeId: true, name: true, phone: true, email: true,
      department: true, designation: true, gender: true, dateOfJoin: true,
      isActive: true, createdAt: true,
      _count: { select: { cleaningRecords: true } }
    };

    const [workers, total] = await Promise.all([
      prisma.worker.findMany({ where, orderBy: orderBy || { name: 'asc' }, select, skip, take }),
      prisma.worker.count({ where })
    ]);

    // Sort by cleanings client-side if requested
    if (sort === 'cleanings') {
      workers.sort((a, b) => (b._count.cleaningRecords) - (a._count.cleaningRecords));
    }

    // Get distinct departments for filter dropdown
    const departments = await prisma.worker.findMany({
      where: { orgId },
      select: { department: true },
      distinct: ['department']
    });
    const deptList = departments.map(d => d.department).filter(Boolean).sort();

    return {
      workers,
      departments: deptList,
      page: pageNum,
      limit: take,
      total,
      totalPages: Math.ceil(total / take)
    };
  });

  // Get single worker
  fastify.get('/workers/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const worker = await prisma.worker.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });
    return decryptWorkerPII(worker);
  });

  // Create worker
  fastify.post('/workers', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const schema = z.object({
      employeeId: z.string().max(50).optional(),
      name: z.string().min(1).max(100).trim(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional().or(z.literal('')),
      address: z.string().max(500).optional(),
      department: z.string().max(100).optional(),
      designation: z.string().max(100).optional(),
      dateOfBirth: z.string().optional(),
      dateOfJoin: z.string().optional(),
      gender: z.enum(['Male', 'Female', 'Other']).optional().or(z.literal('')),
      bloodGroup: z.string().max(10).optional(),
      aadharNo: z.string().max(20).optional(),
      notes: z.string().max(1000).optional()
    });

    const data = schema.parse(request.body);
    const orgId = request.user.orgId;

    // Check duplicate name within org
    const dupName = await prisma.worker.findFirst({ where: { orgId, name: data.name } });
    if (dupName) return reply.code(409).send({ error: 'A worker with this name already exists' });

    if (data.employeeId) {
      const dupId = await prisma.worker.findFirst({ where: { orgId, employeeId: data.employeeId } });
      if (dupId) return reply.code(409).send({ error: 'A worker with this employee ID already exists' });
    }

    const workerData = {
        orgId,
        name: data.name,
        employeeId: data.employeeId || null,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        department: data.department || null,
        designation: data.designation || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        dateOfJoin: data.dateOfJoin ? new Date(data.dateOfJoin) : null,
        gender: data.gender || null,
        bloodGroup: data.bloodGroup || null,
        aadharNo: data.aadharNo || null,
        notes: data.notes || null
    };
    encryptWorkerPII(workerData);

    const worker = await prisma.worker.create({ data: workerData });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'worker_created',
        entityType: 'Worker',
        entityId: worker.id,
        newValue: { name: worker.name, employeeId: worker.employeeId }
      }
    });

    return worker;
  });

  // Update worker
  fastify.patch('/workers/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      employeeId: z.string().max(50).optional().nullable().or(z.literal('')),
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional().nullable().or(z.literal('')),
      email: z.string().email().max(200).optional().nullable().or(z.literal('')),
      address: z.string().max(500).optional().nullable().or(z.literal('')),
      department: z.string().max(100).optional().nullable().or(z.literal('')),
      designation: z.string().max(100).optional().nullable().or(z.literal('')),
      dateOfBirth: z.string().optional().nullable().or(z.literal('')),
      dateOfJoin: z.string().optional().nullable().or(z.literal('')),
      gender: z.enum(['Male', 'Female', 'Other']).optional().nullable().or(z.literal('')),
      bloodGroup: z.string().max(10).optional().nullable().or(z.literal('')),
      aadharNo: z.string().max(20).optional().nullable().or(z.literal('')),
      notes: z.string().max(1000).optional().nullable().or(z.literal('')),
      isActive: z.boolean().optional()
    });

    const data = schema.parse(request.body);

    const worker = await prisma.worker.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });

    // Check duplicate name
    if (data.name && data.name !== worker.name) {
      const dup = await prisma.worker.findFirst({ where: { orgId: request.user.orgId, name: data.name } });
      if (dup) return reply.code(409).send({ error: 'A worker with this name already exists' });
    }

    // Check duplicate employeeId
    if (data.employeeId && data.employeeId !== worker.employeeId) {
      const dup = await prisma.worker.findFirst({ where: { orgId: request.user.orgId, employeeId: data.employeeId } });
      if (dup) return reply.code(409).send({ error: 'A worker with this employee ID already exists' });
    }

    // Normalize empty strings to null for clearable fields
    const clearableFields = ['employeeId', 'phone', 'email', 'address', 'department', 'designation', 'bloodGroup', 'aadharNo', 'notes', 'gender'];
    for (const f of clearableFields) {
      if (data[f] === '') data[f] = null;
    }
    if (data.dateOfBirth === '') data.dateOfBirth = null;
    else if (data.dateOfBirth) data.dateOfBirth = new Date(data.dateOfBirth);
    if (data.dateOfJoin === '') data.dateOfJoin = null;
    else if (data.dateOfJoin) data.dateOfJoin = new Date(data.dateOfJoin);

    // Audit log for status changes
    if (data.isActive !== undefined && data.isActive !== worker.isActive) {
      await prisma.auditLog.create({
        data: {
          orgId: request.user.orgId,
          actorType: 'admin',
          actorId: request.user.id,
          action: data.isActive ? 'worker_reactivated' : 'worker_deactivated',
          entityType: 'Worker',
          entityId: id,
          oldValue: { isActive: worker.isActive },
          newValue: { isActive: data.isActive }
        }
      });
    }

    // Encrypt sensitive fields before write
    encryptWorkerPII(data);

    return prisma.worker.update({ where: { id }, data });
  });

  // Deactivate worker (using DELETE for REST convention)
  fastify.delete('/workers/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;

    const worker = await prisma.worker.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });

    await prisma.worker.update({ where: { id }, data: { isActive: false } });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'worker_deactivated',
        entityType: 'Worker',
        entityId: id,
        oldValue: { name: worker.name }
      }
    });

    return { success: true, message: 'Worker deactivated' };
  });

  // Worker cleaning stats by period
  fastify.get('/workers/:id/stats', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const worker = await prisma.worker.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);
    const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const base = { workers: { some: { id } } };
    const [daily, weekly, monthly, yearly, total] = await Promise.all([
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: today } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: weekAgo } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: monthAgo } } }),
      prisma.cleaningRecord.count({ where: { ...base, cleanedAt: { gte: yearAgo } } }),
      prisma.cleaningRecord.count({ where: base })
    ]);

    return { daily, weekly, monthly, yearly, total };
  });

  // Permanent delete worker (must be deactivated first)
  fastify.delete('/workers/:id/permanent', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const worker = await prisma.worker.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });
    if (worker.isActive) {
      return reply.code(400).send({ error: 'Worker must be deactivated before permanent deletion' });
    }

    // Disconnect from cleaning records, then delete
    await prisma.worker.update({
      where: { id },
      data: { cleaningRecords: { set: [] } }
    });
    await prisma.worker.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'worker_deleted_permanent',
        entityType: 'Worker',
        entityId: id,
        oldValue: { name: worker.name, employeeId: worker.employeeId }
      }
    });

    return { success: true, message: 'Worker permanently deleted' };
  });
}

module.exports = workerRoutes;
