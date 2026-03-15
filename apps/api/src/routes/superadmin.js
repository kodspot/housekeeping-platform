'use strict';

const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST, passwordSchema } = require('../lib/security');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { encryptWorkerPII, decryptWorkerPII } = require('../lib/crypto');
const { APP_URL } = require('../config/env');

async function superadminRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('SUPER_ADMIN'));

  // === Organizations ===

  fastify.get('/superadmin/organizations', async (request) => {
    const { status, search } = request.query;
    const where = {};
    if (status) where.status = status;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    return prisma.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, slug: true, type: true, address: true, phone: true, email: true,
        logoUrl: true, status: true, enabledModules: true, createdAt: true, updatedAt: true,
        _count: { select: { users: true, workers: true, locations: true } }
      }
    });
  });

  fastify.post('/superadmin/organizations', async (request, reply) => {
    const VALID_MODULES = ['hk', 'ele', 'civil', 'asset', 'complaints'];
    const schema = z.object({
      name: z.string().min(1).max(200).trim(),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens only').optional(),
      type: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      enabledModules: z.array(z.enum(VALID_MODULES)).min(1).optional()
    });

    const data = schema.parse(request.body);
    if (!data.enabledModules) data.enabledModules = ['hk'];

    // Use provided slug or auto-generate from name
    let slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
    if (!slug) slug = 'org-' + Date.now().toString(36).slice(-6);
    // Ensure uniqueness
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (existing) return reply.code(409).send({ error: 'Slug "' + slug + '" is already taken. Choose a different one.' });
    data.slug = slug;

    const org = await prisma.organization.create({ data });

    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_created',
        entityType: 'Organization',
        entityId: org.id,
        newValue: data
      }
    });

    return org;
  });

  fastify.patch('/superadmin/organizations/:id', async (request, reply) => {
    const { id } = request.params;
    const VALID_MODULES = ['hk', 'ele', 'civil', 'asset', 'complaints'];
    const schema = z.object({
      name: z.string().min(1).max(200).trim().optional(),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens (no leading/trailing hyphens)').optional(),
      type: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional().or(z.literal('')),
      status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      enabledModules: z.array(z.enum(VALID_MODULES)).min(1).optional()
    });

    const data = schema.parse(request.body);
    if (data.email === '') data.email = null;

    const existing = await prisma.organization.findUnique({ where: { id } });
    if (!existing || existing.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    // If slug is being changed, check uniqueness
    if (data.slug && data.slug !== existing.slug) {
      const slugTaken = await prisma.organization.findUnique({ where: { slug: data.slug } });
      if (slugTaken) return reply.code(409).send({ error: 'Slug "' + data.slug + '" is already taken.' });
    }

    const updated = await prisma.organization.update({ where: { id }, data });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_updated',
        entityType: 'Organization',
        entityId: id,
        oldValue: { name: existing.name, status: existing.status },
        newValue: data
      }
    });

    return updated;
  });

  fastify.delete('/superadmin/organizations/:id', async (request, reply) => {
    const { id } = request.params;

    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org || org.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    await prisma.organization.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        purgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_deleted',
        entityType: 'Organization',
        entityId: id
      }
    });

    return { success: true, message: 'Organization soft-deleted' };
  });

  // === Admin Users ===

  fastify.post('/superadmin/organizations/:orgId/admins', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      phone: z.string().max(20).optional(),
      password: passwordSchema
    });

    const data = schema.parse(request.body);
    const normalizedEmail = data.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { orgId_email: { orgId, email: normalizedEmail } }
    });
    if (existing) {
      return reply.code(409).send({ error: 'A user with this email already exists in this organization' });
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

    const admin = await prisma.user.create({
      data: {
        orgId,
        name: data.name,
        email: normalizedEmail,
        phone: data.phone || null,
        passwordHash,
        role: 'ADMIN'
      },
      select: { id: true, name: true, email: true, phone: true, role: true, orgId: true, createdAt: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'admin_created',
        entityType: 'User',
        entityId: admin.id,
        newValue: { name: admin.name, email: admin.email }
      }
    });

    return admin;
  });

  fastify.get('/superadmin/users', async (request) => {
    const { orgId, role } = request.query;
    const where = {};
    if (orgId) where.orgId = orgId;
    if (role) where.role = role;

    return prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        orgId: true, isActive: true, createdAt: true,
        org: { select: { id: true, name: true } }
      }
    });
  });

  fastify.patch('/superadmin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().uuid().optional()
    });

    const data = schema.parse(request.body);
    if (data.email) data.email = data.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    // If changing org, validate the target org exists and is active
    const targetOrgId = data.orgId || user.orgId;
    if (data.orgId && data.orgId !== user.orgId) {
      const targetOrg = await prisma.organization.findUnique({ where: { id: data.orgId } });
      if (!targetOrg || targetOrg.status !== 'ACTIVE') {
        return reply.code(400).send({ error: 'Target organization not found or not active' });
      }
    }

    // If changing email or org, check uniqueness within the target org
    const emailToCheck = data.email || user.email;
    const emailChanged = data.email && data.email !== user.email;
    const orgChanged = data.orgId && data.orgId !== user.orgId;
    if ((emailChanged || orgChanged) && targetOrgId) {
      const dup = await prisma.user.findUnique({
        where: { orgId_email: { orgId: targetOrgId, email: emailToCheck } }
      });
      if (dup && dup.id !== id) return reply.code(409).send({ error: 'Email already in use in the target organization' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, orgId: true }
    });

    const oldValue = { name: user.name, email: user.email };
    if (orgChanged) oldValue.orgId = user.orgId;

    await prisma.auditLog.create({
      data: {
        orgId: targetOrgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: orgChanged ? 'user_transferred' : 'user_updated',
        entityType: 'User',
        entityId: id,
        oldValue,
        newValue: data
      }
    });

    return updated;
  });

  fastify.patch('/superadmin/users/:id/password', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      password: passwordSchema
    });

    const { password } = schema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await prisma.user.update({ where: { id }, data: { passwordHash } });

    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'password_reset',
        entityType: 'User',
        entityId: id
      }
    });

    return { success: true, message: 'Password updated' };
  });

  // === Supervisor Management (SuperAdmin can create/manage supervisors for any org) ===

  fastify.post('/superadmin/organizations/:orgId/supervisors', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      phone: z.string().max(20).optional(),
      password: passwordSchema
    });

    const data = schema.parse(request.body);
    const normalizedEmail = data.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { orgId_email: { orgId, email: normalizedEmail } }
    });
    if (existing) return reply.code(409).send({ error: 'A user with this email already exists in this organization' });

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

    const supervisor = await prisma.user.create({
      data: { orgId, name: data.name, email: normalizedEmail, phone: data.phone || null, passwordHash, role: 'SUPERVISOR' },
      select: { id: true, name: true, email: true, phone: true, role: true, orgId: true, createdAt: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'supervisor_created',
        entityType: 'User',
        entityId: supervisor.id,
        newValue: { name: supervisor.name, email: supervisor.email }
      }
    });

    return supervisor;
  });

  // === Worker Management (SuperAdmin can manage workers for any org) ===

  fastify.get('/superadmin/organizations/:orgId/workers', async (request, reply) => {
    const { orgId } = request.params;
    return prisma.worker.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: {
        id: true, employeeId: true, name: true, phone: true, email: true,
        department: true, designation: true, gender: true, dateOfJoin: true,
        isActive: true, createdAt: true,
        _count: { select: { cleaningRecords: true } }
      }
    });
  });

  fastify.post('/superadmin/organizations/:orgId/workers', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      employeeId: z.string().max(50).optional(),
      name: z.string().min(1).max(100).trim(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      address: z.string().max(500).optional(),
      department: z.string().max(100).optional(),
      designation: z.string().max(100).optional(),
      dateOfBirth: z.string().optional(),
      dateOfJoin: z.string().optional(),
      gender: z.enum(['Male', 'Female', 'Other']).optional(),
      bloodGroup: z.string().max(10).optional(),
      aadharNo: z.string().max(20).optional(),
      notes: z.string().max(1000).optional()
    });

    const data = schema.parse(request.body);

    // Check duplicate name
    const dupName = await prisma.worker.findFirst({ where: { orgId, name: data.name } });
    if (dupName) return reply.code(409).send({ error: 'A worker with this name already exists in this organization' });

    // Check duplicate employeeId
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
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'worker_created',
        entityType: 'Worker',
        entityId: worker.id,
        newValue: { name: worker.name, employeeId: worker.employeeId }
      }
    });

    return worker;
  });

  fastify.patch('/superadmin/workers/:id', async (request, reply) => {
    const { id } = request.params;

    const worker = await prisma.worker.findUnique({ where: { id } });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });

    const schema = z.object({
      employeeId: z.string().max(50).optional(),
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional().or(z.literal('')),
      address: z.string().max(500).optional(),
      department: z.string().max(100).optional(),
      designation: z.string().max(100).optional(),
      dateOfBirth: z.string().optional().nullable(),
      dateOfJoin: z.string().optional().nullable(),
      gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
      bloodGroup: z.string().max(10).optional(),
      aadharNo: z.string().max(20).optional(),
      notes: z.string().max(1000).optional(),
      isActive: z.boolean().optional()
    });

    const data = schema.parse(request.body);

    // Check duplicate name
    if (data.name && data.name !== worker.name) {
      const dup = await prisma.worker.findFirst({ where: { orgId: worker.orgId, name: data.name } });
      if (dup) return reply.code(409).send({ error: 'A worker with this name already exists' });
    }

    // Check duplicate employeeId
    if (data.employeeId && data.employeeId !== worker.employeeId) {
      const dup = await prisma.worker.findFirst({ where: { orgId: worker.orgId, employeeId: data.employeeId } });
      if (dup) return reply.code(409).send({ error: 'A worker with this employee ID already exists' });
    }

    if (data.email === '') data.email = null;
    if (data.dateOfBirth) data.dateOfBirth = new Date(data.dateOfBirth);
    if (data.dateOfJoin) data.dateOfJoin = new Date(data.dateOfJoin);

    encryptWorkerPII(data);

    return prisma.worker.update({ where: { id }, data });
  });

  // === System Analytics (cross-org stats for SuperAdmin) ===

  fastify.get('/superadmin/analytics', async (request) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalOrgs,
      activeOrgs,
      totalAdmins,
      totalSupervisors,
      totalWorkers,
      totalLocations,
      totalRecords,
      todayRecords,
      totalImages,
      totalTickets,
      openTickets
    ] = await Promise.all([
      prisma.organization.count({ where: { status: { not: 'DELETED' } } }),
      prisma.organization.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
      prisma.user.count({ where: { role: 'SUPERVISOR', isActive: true } }),
      prisma.worker.count({ where: { isActive: true } }),
      prisma.location.count({ where: { isActive: true } }),
      prisma.cleaningRecord.count(),
      prisma.cleaningRecord.count({ where: { cleanedAt: { gte: todayStart } } }),
      prisma.cleaningImage.count(),
      prisma.ticket.count(),
      prisma.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } })
    ]);

    // Daily cleaning activity for last 7 days
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);
    last7Days.setHours(0, 0, 0, 0);

    const dailyTrend = await prisma.$queryRaw`
      SELECT DATE("cleanedAt") as date, COUNT(*)::int as count
      FROM "CleaningRecord"
      WHERE "cleanedAt" >= ${last7Days}
      GROUP BY DATE("cleanedAt")
      ORDER BY date ASC
    `;

    const recordsLast7Days = (dailyTrend || []).reduce((sum, d) => sum + d.count, 0);

    return {
      totalOrgs, activeOrgs, totalAdmins, totalSupervisors, totalWorkers, totalLocations,
      totalRecords, todayRecords, totalImages, totalTickets, openTickets,
      totalQrScans: totalRecords,
      recordsLast7Days,
      avgImagesPerRecord: totalRecords > 0 ? (totalImages / totalRecords).toFixed(1) : '0',
      dailyTrend: (dailyTrend || []).map(d => ({ date: d.date, count: d.count }))
    };
  });

  // Per-org breakdown
  fastify.get('/superadmin/analytics/orgs', async (request) => {
    const orgs = await prisma.organization.findMany({
      where: { status: { not: 'DELETED' } },
      select: {
        id: true, name: true, status: true,
        _count: {
          select: { users: true, workers: true, locations: true, cleaningRecords: true, tickets: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get image counts per org
    const imageCounts = await prisma.$queryRaw`
      SELECT cr."orgId", COUNT(ci.id)::int as "imageCount"
      FROM "CleaningImage" ci
      JOIN "CleaningRecord" cr ON ci."cleaningRecordId" = cr.id
      GROUP BY cr."orgId"
    `;
    const imageMap = new Map((imageCounts || []).map(r => [r.orgId, r.imageCount]));

    return orgs.map(o => ({
      ...o,
      imageCount: imageMap.get(o.id) || 0
    }));
  });

  // Per-org worker performance (SuperAdmin can view worker analytics for any org)
  fastify.get('/superadmin/analytics/orgs/:orgId/workers', async (request) => {
    const { orgId } = request.params;

    const workers = await prisma.worker.findMany({
      where: { orgId },
      select: {
        id: true, employeeId: true, name: true, isActive: true,
        cleaningRecords: {
          select: { cleanedAt: true, _count: { select: { images: true } } },
          orderBy: { cleanedAt: 'desc' }
        }
      },
      orderBy: { name: 'asc' }
    });

    return workers.map(w => ({
      id: w.id,
      employeeId: w.employeeId,
      name: w.name,
      isActive: w.isActive,
      totalRecords: w.cleaningRecords.length,
      totalImages: w.cleaningRecords.reduce((s, r) => s + r._count.images, 0),
      lastCleaningAt: w.cleaningRecords[0]?.cleanedAt || null
    }));
  });

  // === Audit Logs ===
  fastify.get('/superadmin/audit-logs', async (request) => {
    const { orgId, action, actorId, limit, offset } = request.query;
    const where = {};
    if (orgId) where.orgId = orgId;
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (actorId) where.actorId = actorId;

    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = parseInt(offset) || 0;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          org: { select: { name: true } }
        }
      }),
      prisma.auditLog.count({ where })
    ]);

    // Resolve actor names
    const actorIds = [...new Set(logs.filter(l => l.actorId).map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true, role: true } })
      : [];
    const actorMap = new Map(actors.map(a => [a.id, a]));

    return {
      logs: logs.map(l => ({
        ...l,
        actorName: l.actorId ? (actorMap.get(l.actorId)?.name || 'Unknown') : l.actorType,
        actorRole: l.actorId ? (actorMap.get(l.actorId)?.role || null) : null,
        orgName: l.org?.name || null
      })),
      total,
      limit: take,
      offset: skip
    };
  });

  // === Login QR Code Generator (for superadmin) ===
  const VALID_MODULES_QR = ['hk', 'ele', 'civil', 'asset', 'complaints'];
  const VALID_ROLES_QR = ['admin', 'supervisor'];

  fastify.get('/superadmin/organizations/:id/login-qr', async (request, reply) => {
    const { id } = request.params;
    const { mod, role } = request.query;

    if (!mod || VALID_MODULES_QR.indexOf(mod) === -1) {
      return reply.code(400).send({ error: 'Invalid module. Must be one of: ' + VALID_MODULES_QR.join(', ') });
    }
    if (!role || VALID_ROLES_QR.indexOf(role) === -1) {
      return reply.code(400).send({ error: 'Invalid role. Must be admin or supervisor' });
    }

    const org = await prisma.organization.findUnique({
      where: { id },
      select: { slug: true, enabledModules: true, status: true }
    });
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    if (!org.slug) return reply.code(400).send({ error: 'Organization has no slug configured' });

    const enabledMods = org.enabledModules || ['hk'];
    if (enabledMods.indexOf(mod) === -1) {
      return reply.code(400).send({ error: 'Module "' + mod + '" is not enabled for this organization' });
    }

    const loginPage = role === 'admin' ? 'admin-login' : 'supervisor-login';
    const qrData = `${APP_URL}/${org.slug}/${mod}/${loginPage}`;

    const svg = await QRCode.toString(qrData, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#1e293b', light: '#ffffff' }
    });

    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=3600');
    return svg;
  });
}

module.exports = superadminRoutes;
