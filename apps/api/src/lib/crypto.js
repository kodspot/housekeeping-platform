'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.DATA_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string. Returns "iv:ciphertext:tag" (hex-encoded).
 * Returns the original value unchanged if encryption key is not configured.
 */
function encryptField(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

/**
 * Decrypt a "iv:ciphertext:tag" string back to plaintext.
 * Returns the original value unchanged if it doesn't look encrypted or key is missing.
 */
function decryptField(ciphertext) {
  if (!ciphertext) return ciphertext;
  const key = getKey();
  if (!key) return ciphertext;

  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext; // not encrypted, return as-is

  try {
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');

    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return ciphertext;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return ciphertext; // decryption failed, return as-is (likely not encrypted)
  }
}

/** Encrypt sensitive worker fields in-place before database write */
function encryptWorkerPII(data) {
  if (data.aadharNo) data.aadharNo = encryptField(data.aadharNo);
  if (data.bloodGroup) data.bloodGroup = encryptField(data.bloodGroup);
  return data;
}

/** Decrypt sensitive worker fields in-place after database read */
function decryptWorkerPII(worker) {
  if (!worker) return worker;
  if (worker.aadharNo) worker.aadharNo = decryptField(worker.aadharNo);
  if (worker.bloodGroup) worker.bloodGroup = decryptField(worker.bloodGroup);
  return worker;
}

module.exports = { encryptField, decryptField, encryptWorkerPII, decryptWorkerPII };
