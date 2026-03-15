'use strict';

const { prisma } = require('../lib/prisma');

const ORG_PAGES = [
  'admin-login', 'admin-dashboard', 'admin-analytics', 'admin-locations',
  'admin-workers', 'admin-supervisors', 'admin-cleaning', 'admin-tickets',
  'admin-audit-logs', 'admin-qr-print',
  'supervisor-login', 'supervisor-scan', 'supervisor-clean', 'supervisor-tickets'
];

async function pageRoutes(fastify) {
  const sendPage = (file) => (_req, reply) => reply.sendFile(file);

  // Root landing
  fastify.get('/', sendPage('index.html'));

  // SuperAdmin pages (no org prefix)
  fastify.get('/superadmin-login', sendPage('superadmin-login.html'));
  fastify.get('/superadmin-dashboard', sendPage('superadmin-dashboard.html'));

  // Legal pages
  fastify.get('/privacy', sendPage('privacy.html'));
  fastify.get('/terms', sendPage('terms.html'));

  // QR scan short URL + backward compat
  fastify.get('/s/:code', sendPage('scan.html'));
  fastify.get('/scan/:code', sendPage('scan.html'));

  // Org-scoped pages — validate slug exists
  for (const page of ORG_PAGES) {
    fastify.get(`/:orgSlug/${page}`, async (request, reply) => {
      const { orgSlug } = request.params;
      const org = await prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true, status: true }
      });
      if (!org || org.status === 'DELETED') {
        return reply.code(404).send({ error: 'Organization not found' });
      }
      return reply.sendFile(`${page}.html`);
    });
  }

  // Org slug resolver API (for frontend to get orgId from slug)
  fastify.get('/api/org/:slug', {
    config: { rateLimit: { max: 30, timeWindow: 60000, keyGenerator: (req) => req.ip } }
  }, async (request, reply) => {
    const { slug } = request.params;
    const org = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, status: true, logoUrl: true }
    });
    if (!org || org.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }
    return org;
  });
}

module.exports = pageRoutes;
