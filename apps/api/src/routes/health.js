const { prisma } = require('../lib/prisma');

async function healthRoutes(fastify, opts) {
  fastify.get('/health', { config: { rateLimit: false } }, async () => {
    let dbStatus = 'unknown';
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'disconnected';
    }
    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      database: dbStatus,
      version: process.env.npm_package_version || '1.0.0'
    };
  });
}

module.exports = healthRoutes;
