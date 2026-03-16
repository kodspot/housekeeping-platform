'use strict';

const { prisma } = require('../lib/prisma');

// Valid module codes (keep in sync with superadmin.js VALID_MODULES)
const VALID_MODULES = ['hk', 'ele', 'civil', 'asset', 'complaints'];

// Pages within a module scope
const MODULE_PAGES = [
  'admin-login', 'admin-dashboard', 'admin-analytics', 'admin-locations',
  'admin-workers', 'admin-supervisors', 'admin-cleaning', 'admin-tickets',
  'admin-audit-logs', 'admin-qr-print',
  'supervisor-login', 'supervisor-scan', 'supervisor-clean', 'supervisor-tickets'
];

// Module metadata for dynamic manifests
const MODULE_META = {
  hk:         { name: 'Kodspot HK',          short: 'HK',          color: '#1a7f64', desc: 'Housekeeping management' },
  ele:        { name: 'Kodspot Electrical',   short: 'Electrical',  color: '#d97706', desc: 'Electrical maintenance' },
  civil:      { name: 'Kodspot Civil',        short: 'Civil',       color: '#6366f1', desc: 'Civil maintenance' },
  asset:      { name: 'Kodspot Assets',       short: 'Assets',      color: '#0891b2', desc: 'Asset management' },
  complaints: { name: 'Kodspot Complaints',   short: 'Complaints',  color: '#e11d48', desc: 'Complaint management' }
};

async function pageRoutes(fastify) {
  const sendPage = (file) => (_req, reply) => reply.sendFile(file);

  // Helper: validate org slug exists and is active
  async function validateOrg(slug) {
    const org = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true, status: true, enabledModules: true }
    });
    if (!org || org.status === 'DELETED') return null;
    return org;
  }

  // Guard: org slugs are lowercase alphanumeric with hyphens, never contain dots
  function isStaticFile(str) { return str.includes('.'); }

  // Known static asset directories in /public
  var STATIC_DIRS = new Set(['css', 'js']);

  // ── Static pages ──
  fastify.get('/', sendPage('index.html'));
  fastify.get('/superadmin-login', sendPage('superadmin-login.html'));
  fastify.get('/superadmin-dashboard', sendPage('superadmin-dashboard.html'));
  fastify.get('/privacy', sendPage('privacy.html'));
  fastify.get('/terms', sendPage('terms.html'));

  // QR scan short URL
  fastify.get('/s/:code', sendPage('scan.html'));
  fastify.get('/scan/:code', sendPage('scan.html'));

  // ── Org landing page: /{org} ──
  fastify.get('/:orgSlug', async (request, reply) => {
    const { orgSlug } = request.params;
    // Serve root-level static files (site.webmanifest, favicon.ico, robots.txt, etc.)
    if (isStaticFile(orgSlug)) return reply.sendFile(orgSlug);
    // Don't treat static dir names as org slugs
    if (STATIC_DIRS.has(orgSlug)) return reply.code(404).send({ error: 'Not found' });
    const org = await validateOrg(orgSlug);
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    return reply.sendFile('org-home.html');
  });

  // ── Module landing page: /{org}/{mod} ──
  fastify.get('/:orgSlug/:mod', async (request, reply) => {
    const { orgSlug, mod } = request.params;
    // Serve static asset files (e.g. /css/design-system.css, /js/app.js)
    if (STATIC_DIRS.has(orgSlug)) return reply.sendFile(orgSlug + '/' + mod);
    if (!VALID_MODULES.includes(mod)) return reply.callNotFound();
    const org = await validateOrg(orgSlug);
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    if (!(org.enabledModules || ['hk']).includes(mod)) {
      return reply.code(404).send({ error: 'Module not enabled for this organization' });
    }
    return reply.sendFile('module-home.html');
  });

  // ── Dynamic PWA manifest: /{org}/{mod}/manifest.json ──
  fastify.get('/:orgSlug/:mod/manifest.json', async (request, reply) => {
    const { orgSlug, mod } = request.params;
    if (!VALID_MODULES.includes(mod)) return reply.callNotFound();
    const org = await prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { name: true, status: true }
    });
    if (!org || org.status === 'DELETED') return reply.callNotFound();

    const meta = MODULE_META[mod] || MODULE_META.hk;
    const scope = `/${orgSlug}/${mod}/`;
    const manifest = {
      name: `${org.name} — ${meta.name}`,
      short_name: `${meta.short}`,
      description: meta.desc,
      start_url: scope,
      scope: scope,
      display: 'standalone',
      orientation: 'any',
      theme_color: meta.color,
      background_color: '#ffffff',
      categories: ['business', 'productivity'],
      lang: 'en-IN',
      icons: [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    };
    reply.header('Content-Type', 'application/manifest+json');
    reply.header('Cache-Control', 'public, max-age=3600');
    return manifest;
  });

  // ── Module-scoped service worker: /{org}/{mod}/sw.js ──
  fastify.get('/:orgSlug/:mod/sw.js', async (request, reply) => {
    const { orgSlug, mod } = request.params;
    if (!VALID_MODULES.includes(mod)) return reply.callNotFound();
    const org = await validateOrg(orgSlug);
    if (!org) return reply.callNotFound();
    const meta = MODULE_META[mod] || MODULE_META.hk;
    const scope = `/${orgSlug}/${mod}/`;

    const swCode = `// ${meta.name} — Module Service Worker (auto-generated)
const CACHE_NAME = 'kodspot-${mod}-v5';
const SCOPE = '${scope}';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([OFFLINE_URL, '/css/design-system.css?v=6', '/js/app.js?v=6', '/favicon-32x32.png', '/android-chrome-192x192.png'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (url.pathname.match(/\\.(css|js|png|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((response) => {
          if (response.ok) { const clone = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)); }
          return response;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});`;
    reply.header('Content-Type', 'application/javascript');
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Service-Worker-Allowed', scope);
    return swCode;
  });

  // ── Module-scoped pages: /{org}/{mod}/{page} ──
  for (const page of MODULE_PAGES) {
    fastify.get('/:orgSlug/:mod/' + page, async (request, reply) => {
      const { orgSlug, mod } = request.params;
      if (!VALID_MODULES.includes(mod)) return reply.callNotFound();
      const org = await validateOrg(orgSlug);
      if (!org) return reply.code(404).send({ error: 'Organization not found' });
      return reply.sendFile(`${page}.html`);
    });
  }

  // ── Backward compatibility: /{org}/{page} → redirect to /{org}/hk/{page} ──
  for (const page of MODULE_PAGES) {
    fastify.get('/:orgSlug/' + page, async (request, reply) => {
      const { orgSlug } = request.params;
      const org = await validateOrg(orgSlug);
      if (!org) return reply.code(404).send({ error: 'Organization not found' });
      // Default module is hk for backward compatibility
      return reply.redirect(301, `/${orgSlug}/hk/${page}`);
    });
  }

  // ── Org slug resolver API ──
  fastify.get('/api/org/:slug', {
    config: { rateLimit: { max: 30, timeWindow: 60000, keyGenerator: (req) => req.ip } }
  }, async (request, reply) => {
    const { slug } = request.params;
    const org = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, status: true, logoUrl: true, enabledModules: true }
    });
    if (!org || org.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }
    return org;
  });
}

module.exports = pageRoutes;
