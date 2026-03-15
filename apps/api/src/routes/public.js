'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { notifyAdmins, notifySupervisors } = require('./notifications');

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
        // We'll get orgId from location below to namespace the upload
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
    if (imageUrl === '__pending__' && request.isMultipart()) {
      const imageFile = request.body.image;
      const file = Array.isArray(imageFile) ? imageFile[0] : imageFile;
      const buffer = await file.toBuffer();
      imageUrl = await uploadToR2(buffer, file.mimetype, location.orgId);
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
}

module.exports = publicRoutes;
