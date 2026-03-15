'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST, passwordSchema } = require('../lib/security');
const { strictRateLimit, loginRateLimit } = require('../middleware/rateLimits');
const { authenticateJWT } = require('../middleware/auth');

// Constant-time comparison that doesn't leak input length
function safeCompareKeys(input, secret) {
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(input), hash(secret));
}

async function authRoutes(fastify, opts) {

  // Bootstrap: Create first SUPER_ADMIN (one-time, protected by ADMIN_KEY)
  fastify.post('/auth/bootstrap', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      adminKey: z.string().min(1),
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      password: passwordSchema
    });

    const { adminKey, name, email, password } = schema.parse(request.body);

    if (!process.env.ADMIN_KEY || !safeCompareKeys(adminKey, process.env.ADMIN_KEY)) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(403).send({ error: 'Invalid admin key' });
    }

    // Only allow if no SUPER_ADMIN exists yet
    const existing = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    if (existing) {
      return reply.code(409).send({ error: 'SuperAdmin already exists. Use /auth/login instead.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase().trim(),
        passwordHash,
        role: 'SUPER_ADMIN',
        orgId: null
      }
    });

    const token = jwt.sign(
      { userId: user.id, orgId: null, role: 'SUPER_ADMIN' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  // Login: email + password → JWT (also supports ADMIN_KEY-only for SuperAdmin)
  fastify.post('/auth/login', {
    config: { rateLimit: loginRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      email: z.string().email().max(200).optional(),
      password: z.string().min(1).max(100).optional(),
      orgId: z.string().uuid().optional(),
      orgSlug: z.string().max(50).optional(),
      adminKey: z.string().min(1).optional()
    });

    const { email, password, orgId, orgSlug, adminKey } = schema.parse(request.body);

    // ADMIN_KEY-only login for SuperAdmin
    if (adminKey) {
      if (!process.env.ADMIN_KEY || !safeCompareKeys(adminKey, process.env.ADMIN_KEY)) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return reply.code(401).send({ error: 'Invalid admin key' });
      }
      const superAdmin = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true, orgId: true, role: true, name: true, email: true }
      });
      if (!superAdmin) return reply.code(404).send({ error: 'No SuperAdmin account exists. Use /auth/bootstrap first.' });

      const token = jwt.sign(
        { userId: superAdmin.id, orgId: null, role: 'SUPER_ADMIN' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      return { token, user: { id: superAdmin.id, name: superAdmin.name, email: superAdmin.email, role: superAdmin.role, orgId: null } };
    }

    // Normal email+password login
    if (!email || !password) return reply.code(400).send({ error: 'Email and password are required' });
    const normalizedEmail = email.toLowerCase().trim();

    const users = await prisma.user.findMany({
      where: { email: normalizedEmail, isActive: true },
      select: { id: true, orgId: true, role: true, name: true, email: true, passwordHash: true }
    });

    if (users.length === 0) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Single match or caller specified orgId/orgSlug
    let user;
    if (users.length === 1) {
      user = users[0];
    } else {
      // Resolve orgSlug to orgId if provided
      let resolvedOrgId = orgId;
      if (!resolvedOrgId && orgSlug) {
        const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
        if (org) resolvedOrgId = org.id;
      }
      if (!resolvedOrgId) {
        return reply.code(400).send({
          error: 'Multiple accounts found. Please specify organization.',
          organizations: users.map(u => ({ orgId: u.orgId, role: u.role }))
        });
      }
      user = users.find(u => u.orgId === resolvedOrgId);
      if (!user) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Check org status for non-superadmin
    let orgSlugValue = null;
    let orgNameValue = null;
    if (user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { status: true, slug: true, name: true }
      });
      if (!org || org.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'Organization is not active' });
      }
      orgSlugValue = org.slug;
      orgNameValue = org.name;
    }

    const token = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.orgId, orgSlug: orgSlugValue, orgName: orgNameValue }
    };
  });

  // Get current user profile
  fastify.get('/auth/me', {
    preHandler: [authenticateJWT]
  }, async (request) => {
    return prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true, name: true, email: true, phone: true, role: true, orgId: true,
        isActive: true, createdAt: true,
        org: { select: { id: true, name: true, type: true } }
      }
    });
  });

  // Change own password
  fastify.patch('/auth/password', {
    preHandler: [authenticateJWT]
  }, async (request, reply) => {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: passwordSchema
    });

    const { currentPassword, newPassword } = schema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { passwordHash: true }
    });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return reply.code(400).send({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await prisma.user.update({
      where: { id: request.user.id },
      data: { passwordHash, tokenInvalidBefore: new Date() }
    });

    // Issue a fresh token so the current session stays alive
    const newToken = jwt.sign(
      { userId: request.user.id, orgId: request.user.orgId, role: request.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return { success: true, message: 'Password updated', token: newToken };
  });

  // DPDP Act Sec 6 — Data portability: export all personal data for the current user
  fastify.get('/auth/export', {
    preHandler: [authenticateJWT],
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const userId = request.user.id;
    const orgId = request.user.orgId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        designation: true, employeeId: true, department: true, gender: true,
        dateOfBirth: true, dateOfJoin: true, address: true, notes: true,
        isActive: true, createdAt: true, updatedAt: true,
        org: { select: { name: true, type: true } }
      }
    });

    const cleaningRecords = orgId ? await prisma.cleaningRecord.findMany({
      where: { supervisorId: userId },
      select: { id: true, shift: true, notes: true, status: true, cleanedAt: true, createdAt: true,
        location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    const tickets = orgId ? await prisma.ticket.findMany({
      where: { OR: [{ createdById: userId }, { assignedToId: userId }] },
      select: { id: true, title: true, description: true, status: true, priority: true, source: true,
        createdAt: true, resolvedAt: true, location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    const auditLogs = orgId ? await prisma.auditLog.findMany({
      where: { actorId: userId },
      select: { id: true, action: true, entityType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    reply.header('content-disposition', 'attachment; filename="kodspot-data-export.json"');
    return {
      exportedAt: new Date().toISOString(),
      platform: 'Kodspot Housekeeping',
      user,
      cleaningRecords,
      tickets,
      auditLogs
    };
  });
}

module.exports = authRoutes;
