'use strict';

const { prisma } = require('../lib/prisma');
const { deleteFromR2 } = require('../lib/r2');

const RETENTION_DAYS = 7;

/**
 * Deletes cleaning images older than RETENTION_DAYS from R2 storage
 * and nulls out the imageUrl in the database.
 * Cleaning records (metadata) are kept forever — only images are removed.
 */
async function cleanupExpiredImages(logger) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  // Find images older than retention period that still have a valid URL
  const expiredImages = await prisma.cleaningImage.findMany({
    where: {
      createdAt: { lt: cutoff },
      imageUrl: { not: '', startsWith: '/images/' }
    },
    select: { id: true, imageUrl: true }
  });

  if (expiredImages.length === 0) {
    logger.info(`[cleanup] No expired images found (retention: ${RETENTION_DAYS} days)`);
    return 0;
  }

  logger.info(`[cleanup] Found ${expiredImages.length} expired images to clean up`);

  let deleted = 0;
  let failed = 0;

  for (const img of expiredImages) {
    try {
      // Delete from R2 storage
      await deleteFromR2(img.imageUrl);
      // Null out the URL in the database
      await prisma.cleaningImage.update({
        where: { id: img.id },
        data: { imageUrl: '' }
      });
      deleted++;
    } catch (err) {
      failed++;
      logger.error(`[cleanup] Failed to delete image ${img.id}: ${err.message}`);
    }
  }

  logger.info(`[cleanup] Completed: ${deleted} deleted, ${failed} failed`);
  return deleted;
}

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function startCleanupScheduler(logger) {
  // Run once on startup (with a short delay to not block boot)
  setTimeout(() => {
    cleanupExpiredImages(logger).catch(err => {
      logger.error('[cleanup] Startup cleanup failed:', err.message);
    });
  }, 30000); // 30 seconds after boot

  // Then run every 24 hours
  const interval = setInterval(() => {
    cleanupExpiredImages(logger).catch(err => {
      logger.error('[cleanup] Scheduled cleanup failed:', err.message);
    });
  }, INTERVAL_MS);

  // Allow graceful shutdown to clear the interval
  return interval;
}

module.exports = { cleanupExpiredImages, startCleanupScheduler };
