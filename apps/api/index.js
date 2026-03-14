// Load env + validate before anything else
const { APP_URL } = require('./src/config/env');

const fastify = require('fastify')({
  trustProxy: true,
  genReqId: () => `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: { colorize: true }
    } : undefined
  }
});

// Lib modules — wire up loggers
const { prisma, connectWithRetry } = require('./src/lib/prisma');
const { setLogger: setR2Logger } = require('./src/lib/r2');
setR2Logger(fastify.log);

// Plugins
const { registerSecurityPlugins } = require('./src/plugins/security');
const { registerContentPlugins } = require('./src/plugins/content');

// Routes
const healthRoutes = require('./src/routes/health');
const authRoutes = require('./src/routes/auth');
const superadminRoutes = require('./src/routes/superadmin');
const locationRoutes = require('./src/routes/locations');
const workerRoutes = require('./src/routes/workers');
const supervisorRoutes = require('./src/routes/supervisors');
const cleaningRoutes = require('./src/routes/cleaning');
const ticketRoutes = require('./src/routes/tickets');
const analyticsRoutes = require('./src/routes/analytics');
const publicRoutes = require('./src/routes/public');
const imageRoutes = require('./src/routes/images');
const notificationRoutes = require('./src/routes/notifications');
const auditLogRoutes = require('./src/routes/audit-logs');

// Services
const { startCleanupScheduler } = require('./src/services/cleanup');

// Error handling & logging
const { logError, registerErrorHandlers } = require('./src/errors');

//==================== LIFECYCLE ====================
fastify.addHook('onClose', async () => {
  await prisma.$disconnect();
  fastify.log.info('Server shutting down, database disconnected');
});

//==================== STARTUP ====================
async function start() {
  try {
    await connectWithRetry(fastify.log);
    await registerSecurityPlugins(fastify);
    await registerContentPlugins(fastify);
    registerErrorHandlers(fastify);

    fastify.register(healthRoutes);
    fastify.register(authRoutes);
    fastify.register(superadminRoutes);
    fastify.register(locationRoutes);
    fastify.register(workerRoutes);
    fastify.register(supervisorRoutes);
    fastify.register(cleaningRoutes);
    fastify.register(ticketRoutes);
    fastify.register(analyticsRoutes);
    fastify.register(publicRoutes);
    fastify.register(imageRoutes);
    fastify.register(notificationRoutes);
    fastify.register(auditLogRoutes);

    await fastify.listen({
      port: parseInt(process.env.PORT) || 3000,
      host: '0.0.0.0'
    });

    // Start image cleanup scheduler (7-day retention)
    startCleanupScheduler(fastify.log);

    fastify.log.info(`Server listening at ${APP_URL}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  fastify.log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  logError(reason instanceof Error ? reason : new Error(String(reason)));
});

start();

//==================== GRACEFUL SHUTDOWN ====================
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, starting graceful shutdown...`);
    try {
      await fastify.close();
      fastify.log.info('Server closed gracefully');
      process.exit(0);
    } catch (err) {
      fastify.log.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});
