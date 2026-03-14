'use strict';

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
});

let logger = { warn: console.warn, error: console.error, info: console.log };

function setLogger(l) {
  logger = l;
}

async function uploadToR2(buffer, mimetype, orgId) {
  // Compress and convert to WebP for optimal delivery
  try {
    buffer = await sharp(buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    mimetype = 'image/webp';
  } catch (e) {
    // If sharp fails (corrupt image edge case), upload original
    logger.warn('sharp compression failed, uploading original:', e.message);
  }

  const ext = mimetype === 'image/png' ? '.png' :
    mimetype === 'image/webp' ? '.webp' : '.jpg';
  const key = `uploads/${orgId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  });
  await r2Client.send(command);
  // Return API-relative path — images are served privately through /images/ proxy
  return `/images/${key}`;
}

async function getFromR2(key) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  return r2Client.send(command);
}

async function deleteFromR2(imageUrl) {
  if (!imageUrl) return;
  // Extract R2 key from stored path: /images/uploads/orgId/file.webp
  let key = imageUrl;
  if (key.startsWith('/images/')) key = key.slice(8);
  if (!key || !key.startsWith('uploads/')) return;
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  await r2Client.send(command);
}

module.exports = { r2Client, uploadToR2, getFromR2, deleteFromR2, setLogger };
