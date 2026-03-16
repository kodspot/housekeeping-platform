'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { notifyAdmins, notifySupervisors, createNotification } = require('./notifications');

const ISSUE_TYPES = ['NOT_CLEAN', 'BAD_SMELL', 'BROKEN_EQUIPMENT', 'WATER_ISSUE', 'PEST', 'LINEN', 'WASTE', 'OTHER'];

async function publicRoutes(fastify, opts) {

  // ── Public: Get location info by QR code (no auth required) ──
  // Returns minimal location info for the complaint form
  fastify.get('/public/location/:code', async (request, reply) => {
    const code = request.params.code.toUpperCase().trim();
    if (!code || code.length < 4 || code.length > 20) {
      return reply.code(400).send({ error: 'Invalid code' });
    }

    const location = await prisma.location.findUnique({
      where: { qrCode: code },
      select: {
        id: true,
        name: true,
        type: true,
        orgId: true,
        isActive: true,
        parent: { select: { name: true } },
        org: { select: { name: true, status: true, slug: true, enabledModules: true } }
      }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    if (location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    return {
      id: location.id,
      name: location.name,
      type: location.type,
      parentName: location.parent?.name || null,
      orgName: location.org.name,
      orgSlug: location.org.slug,
      enabledModules: location.org.enabledModules || ['hk']
    };
  });

  // ── Public: Submit a complaint (no auth required) ──
  // Stricter rate limiting for anonymous complaint submission
  fastify.post('/public/complaint', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    let data, imageUrl = null;
    let _pendingImageBuffer = null, _pendingImageMime = null;

    if (request.isMultipart()) {
      const fieldValue = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };

      data = {
        locationId: fieldValue(request.body.locationId),
        issueType: fieldValue(request.body.issueType),
        description: fieldValue(request.body.description)?.trim() || null,
        guestName: fieldValue(request.body.guestName)?.trim() || null,
        guestPhone: fieldValue(request.body.guestPhone)?.trim() || null
      };

      const imageFile = request.body.image;
      if (imageFile && imageFile.mimetype) {
        const file = Array.isArray(imageFile) ? imageFile[0] : imageFile;
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
          return reply.code(400).send({ error: 'Invalid image type. Use JPEG, PNG or WebP.' });
        }
        const buffer = await file.toBuffer();
        if (buffer.length > 5 * 1024 * 1024) {
          return reply.code(400).send({ error: 'Image too large. Max 5MB.' });
        }
        if (!validateImageBuffer(buffer, file.mimetype)) {
          return reply.code(400).send({ error: 'Invalid image file' });
        }
        // Store buffer for upload after we get orgId from location
        _pendingImageBuffer = buffer;
        _pendingImageMime = file.mimetype;
        imageUrl = '__pending__';
      }
    } else {
      const schema = z.object({
        locationId: z.string().uuid(),
        issueType: z.enum(ISSUE_TYPES),
        description: z.string().max(500).optional(),
        guestName: z.string().max(100).optional(),
        guestPhone: z.string().max(20).optional()
      });
      data = schema.parse(request.body);
    }

    // Validate required fields
    if (!data.locationId || !data.issueType) {
      return reply.code(400).send({ error: 'locationId and issueType are required' });
    }

    if (!ISSUE_TYPES.includes(data.issueType)) {
      return reply.code(400).send({ error: 'Invalid issue type' });
    }

    // Sanitize phone — only keep digits, +, -, spaces
    if (data.guestPhone) {
      data.guestPhone = data.guestPhone.replace(/[^\d+\-\s()]/g, '').substring(0, 20);
    }

    // Look up location to get orgId
    const location = await prisma.location.findUnique({
      where: { id: data.locationId },
      select: { id: true, orgId: true, name: true, isActive: true, org: { select: { status: true } } }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    if (location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    // Handle image upload with proper orgId
    if (imageUrl === '__pending__' && _pendingImageBuffer) {
      imageUrl = await uploadToR2(_pendingImageBuffer, _pendingImageMime, location.orgId);
    }

    // Map issue type to a readable title
    const ISSUE_LABELS = {
      NOT_CLEAN: 'Room Not Clean',
      BAD_SMELL: 'Bad Smell / Odor',
      BROKEN_EQUIPMENT: 'Broken Equipment',
      WATER_ISSUE: 'Water / Plumbing Issue',
      PEST: 'Pest Problem',
      LINEN: 'Linen / Bedding Issue',
      WASTE: 'Waste Not Cleared',
      OTHER: 'Other Issue'
    };

    const title = ISSUE_LABELS[data.issueType] + ' — ' + location.name;

    const ticket = await prisma.ticket.create({
      data: {
        orgId: location.orgId,
        locationId: data.locationId,
        title,
        description: data.description || null,
        imageUrl: imageUrl && imageUrl !== '__pending__' ? imageUrl : null,
        priority: 'NORMAL',
        source: 'PUBLIC',
        guestName: data.guestName || null,
        guestPhone: data.guestPhone || null,
        issueType: data.issueType
      },
      select: {
        id: true,
        title: true,
        issueType: true,
        status: true,
        createdAt: true,
        location: { select: { name: true } }
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: location.orgId,
        actorType: 'guest',
        actorId: data.guestName || 'anonymous',
        action: 'ticket_public_create',
        entityType: 'Ticket',
        entityId: ticket.id,
        newValue: { issueType: data.issueType, locationName: location.name, guestName: data.guestName }
      }
    });

    // Notify admins about new public complaint
    notifyAdmins(location.orgId, {
      type: 'public_complaint',
      title: 'New public complaint',
      body: ticket.title,
      entityId: ticket.id
    }).catch(() => {});

    // Notify supervisors about new public complaint
    notifySupervisors(location.orgId, {
      type: 'public_complaint',
      title: 'New public complaint',
      body: ticket.title,
      entityId: ticket.id
    }).catch(() => {});

    return {
      success: true,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        location: ticket.location.name,
        createdAt: ticket.createdAt
      }
    };
  });

  // ── Public: Get review page data (no auth required) ──
  fastify.get('/public/review/:token', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const { token } = request.params;
    if (!token || token.length !== 64) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { reviewToken: token },
      select: {
        id: true,
        title: true,
        issueType: true,
        status: true,
        source: true,
        resolvedImageUrl: true,
        resolvedNote: true,
        resolvedAt: true,
        reviewStatus: true,
        reviewExpiresAt: true,
        reviewedAt: true,
        createdAt: true,
        location: { select: { name: true, type: true } },
        org: { select: { name: true } }
      }
    });

    if (!ticket) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    // Already reviewed
    if (ticket.reviewStatus !== 'PENDING') {
      return {
        status: 'already_reviewed',
        reviewStatus: ticket.reviewStatus,
        reviewedAt: ticket.reviewedAt
      };
    }

    // Expired
    if (ticket.reviewExpiresAt && new Date() > ticket.reviewExpiresAt) {
      // Auto-close
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: { reviewStatus: 'CONFIRMED', status: 'CLOSED', reviewedAt: new Date() }
      });
      return {
        status: 'expired',
        message: 'This review link has expired. The resolution has been automatically accepted.'
      };
    }

    return {
      status: 'pending',
      ticket: {
        title: ticket.title,
        issueType: ticket.issueType,
        resolvedImageUrl: ticket.resolvedImageUrl,
        resolvedNote: ticket.resolvedNote,
        resolvedAt: ticket.resolvedAt,
        createdAt: ticket.createdAt,
        locationName: ticket.location.name,
        locationType: ticket.location.type,
        orgName: ticket.org.name
      },
      expiresAt: ticket.reviewExpiresAt
    };
  });

  // ── Public: Submit review (confirm/reject resolution) ──
  fastify.post('/public/review/:token', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const { token } = request.params;
    if (!token || token.length !== 64) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    const schema = z.object({
      action: z.enum(['CONFIRM', 'REJECT']),
      note: z.string().max(500).optional()
    });

    let data;
    try {
      data = schema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'Invalid request. action must be CONFIRM or REJECT.' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { reviewToken: token },
      select: {
        id: true,
        orgId: true,
        title: true,
        status: true,
        reviewStatus: true,
        reviewExpiresAt: true,
        assignedToId: true,
        location: { select: { name: true } }
      }
    });

    if (!ticket) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    // Already reviewed
    if (ticket.reviewStatus !== 'PENDING') {
      return reply.code(400).send({ error: 'This resolution has already been reviewed.' });
    }

    // Expired
    if (ticket.reviewExpiresAt && new Date() > ticket.reviewExpiresAt) {
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: { reviewStatus: 'CONFIRMED', status: 'CLOSED', reviewedAt: new Date() }
      });
      return reply.code(400).send({ error: 'This review link has expired. The resolution has been automatically accepted.' });
    }

    const now = new Date();

    if (data.action === 'CONFIRM') {
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: {
          reviewStatus: 'CONFIRMED',
          reviewNote: data.note?.trim() || null,
          reviewedAt: now,
          status: 'CLOSED'
        }
      });

      await prisma.auditLog.create({
        data: {
          orgId: ticket.orgId,
          actorType: 'guest',
          action: 'ticket_review_confirmed',
          entityType: 'Ticket',
          entityId: ticket.id,
          newValue: { reviewStatus: 'CONFIRMED' }
        }
      });

      return { success: true, message: 'Thank you for confirming the resolution!' };
    }

    // REJECT: reopen ticket, clear assignee so it goes back to pool
    await prisma.ticket.update({
      where: { reviewToken: token },
      data: {
        reviewStatus: 'REJECTED',
        reviewNote: data.note?.trim() || null,
        reviewedAt: now,
        status: 'OPEN',
        assignedToId: null
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: ticket.orgId,
        actorType: 'guest',
        action: 'ticket_review_rejected',
        entityType: 'Ticket',
        entityId: ticket.id,
        newValue: { reviewStatus: 'REJECTED', reviewNote: data.note || null }
      }
    });

    // Notify admins about rejection
    notifyAdmins(ticket.orgId, {
      type: 'ticket_review_rejected',
      title: 'Resolution rejected by guest',
      body: ticket.title + (ticket.location ? ' — ' + ticket.location.name : ''),
      entityId: ticket.id
    }).catch(() => {});

    // Notify the supervisor who resolved it
    if (ticket.assignedToId) {
      createNotification({
        orgId: ticket.orgId,
        userId: ticket.assignedToId,
        type: 'ticket_review_rejected',
        title: 'Guest rejected your resolution',
        body: ticket.title + (ticket.location ? ' — ' + ticket.location.name : ''),
        entityId: ticket.id
      }).catch(() => {});
    }

    return { success: true, message: 'Your feedback has been recorded. The issue will be re-opened for further attention.' };
  });
}

module.exports = publicRoutes;
