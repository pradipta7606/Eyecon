import crypto from 'crypto';
import { createChildLogger } from './logger.js';

const log = createChildLogger('security');

const SECRET = process.env.STREAM_SECRET || 'eyecon-dev-secret-change-in-production';
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY_SECONDS || '21600', 10); // 6 hours

// ── Generate a signed token for a video ────────────────────────────────
export function generateStreamToken(videoId: string): { token: string; expires: number } {
  const expires = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS;
  const payload = `${videoId}:${expires}`;
  const token = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return { token, expires };
}

// ── Validate a signed token ────────────────────────────────────────────
export function validateStreamToken(
  videoId: string,
  token: string,
  expires: number | string
): boolean {
  const expiresNum = typeof expires === 'string' ? parseInt(expires, 10) : expires;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now > expiresNum) {
    log.debug({ videoId, expires: expiresNum, now }, 'Token expired');
    return false;
  }

  // Verify HMAC
  const payload = `${videoId}:${expiresNum}`;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

  const isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!isValid) {
    log.debug({ videoId }, 'Token HMAC mismatch');
  }
  return isValid;
}

// ── Extract videoId from a stream path ─────────────────────────────────
export function extractVideoIdFromPath(streamPath: string): string | null {
  // Expected: /streams/<videoId>/... or streams/<videoId>/...
  const match = streamPath.match(/\/?streams\/([a-f0-9-]+)\//i);
  return match ? match[1] : null;
}
