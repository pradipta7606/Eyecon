import fs from 'fs';
import path from 'path';
import { stmts } from './db.js';
import { deletePrefix, isS3Mode } from './storage.js';
import { createChildLogger } from './logger.js';
import type { VideoRecord } from './db.js';

const log = createChildLogger('cleanup');

// ── Clean up failed transcodes ─────────────────────────────────────────
export async function cleanupFailedTranscodes(
  streamsDir: string,
  uploadsDir: string
): Promise<number> {
  let cleaned = 0;

  // Get videos that failed more than 1 hour ago
  const failedVideos = stmts.getFailedVideos.all('-1 hour') as VideoRecord[];

  for (const video of failedVideos) {
    try {
      // Remove stream directory
      const streamPath = path.join(streamsDir, video.id);
      if (fs.existsSync(streamPath)) {
        fs.rmSync(streamPath, { recursive: true, force: true });
        log.info({ videoId: video.id }, 'Cleaned up failed stream files');
      }

      // Remove from S3
      if (isS3Mode()) {
        await deletePrefix(`streams/${video.id}`);
      }

      cleaned++;
    } catch (err) {
      log.error({ videoId: video.id, err }, 'Cleanup error for failed video');
    }
  }

  return cleaned;
}

// ── Clean up orphan uploads ────────────────────────────────────────────
export async function cleanupOrphanUploads(uploadsDir: string): Promise<number> {
  let cleaned = 0;

  if (!fs.existsSync(uploadsDir)) return 0;

  const files = fs.readdirSync(uploadsDir);
  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    const stat = fs.statSync(filePath);

    // If file is older than 24 hours
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 24 * 60 * 60 * 1000) {
      // Check if it has a corresponding DB entry
      const baseName = path.parse(file).name;
      const video = stmts.getVideo.get(baseName) as VideoRecord | undefined;

      if (!video) {
        fs.unlinkSync(filePath);
        cleaned++;
        log.info({ file }, 'Removed orphan upload');
      }
    }
  }

  return cleaned;
}

// ── Clean up temp files ────────────────────────────────────────────────
export async function cleanupTempFiles(): Promise<number> {
  let cleaned = 0;
  const tmpDir = path.resolve(process.cwd(), 'tmp');

  if (!fs.existsSync(tmpDir)) return 0;

  const files = fs.readdirSync(tmpDir);
  for (const file of files) {
    const filePath = path.join(tmpDir, file);
    const stat = fs.statSync(filePath);

    // Remove anything older than 2 hours
    if (Date.now() - stat.mtimeMs > 2 * 60 * 60 * 1000) {
      try {
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
        cleaned++;
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return cleaned;
}

// ── Full cleanup pass ──────────────────────────────────────────────────
export async function runFullCleanup(
  streamsDir: string,
  uploadsDir: string
): Promise<{ failed: number; orphans: number; temp: number }> {
  log.info('Starting full cleanup pass');

  const [failed, orphans, temp] = await Promise.all([
    cleanupFailedTranscodes(streamsDir, uploadsDir),
    cleanupOrphanUploads(uploadsDir),
    cleanupTempFiles(),
  ]);

  log.info({ failed, orphans, temp }, 'Cleanup pass completed');
  return { failed, orphans, temp };
}
