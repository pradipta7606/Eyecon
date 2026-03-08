import { Worker } from 'bullmq';
import path from 'path';
import { fileURLToPath } from 'url';
import { transcodeVideo } from './transcoder.js';
import { extractThumbnail } from './thumbnail.js';
import { runFullCleanup } from './cleanup.js';
import { stmts } from './db.js';
import { ensureBucket } from './storage.js';
import { getOptimalConcurrency, redisConnection } from './queue.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('worker');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Ensure storage is ready ────────────────────────────────────────────
await ensureBucket();

const STREAMS_DIR = path.resolve(__dirname, '../../streams');
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');
const THUMBNAILS_DIR = path.resolve(__dirname, '../../thumbnails');
const concurrency = getOptimalConcurrency();

// ── Transcode Worker ───────────────────────────────────────────────────
const transcodeWorker = new Worker(
  'transcode',
  async (job) => {
    const { videoId, inputPath, outputDir, thumbnailDir } = job.data;
    log.info({ videoId, jobId: job.id }, 'Processing transcode job');

    try {
      stmts.updateStatus.run('processing', 'Transcode job started', 5, videoId);

      // Run transcoding with progress callback
      await transcodeVideo(videoId, inputPath, outputDir, (percent, detail) => {
        job.updateProgress(percent);
        stmts.updateStatus.run('processing', detail, percent, videoId);
      });

      // Extract thumbnail
      try {
        const thumbPath = await extractThumbnail(videoId, inputPath, thumbnailDir);
        log.info({ videoId, thumbPath }, 'Thumbnail created');
      } catch (thumbErr) {
        log.warn({ videoId, err: thumbErr }, 'Thumbnail extraction failed, continuing');
      }

      // Mark complete
      stmts.completeVideo.run(
        'Transcoding complete — all variants ready',
        `/thumbnails/${videoId}.jpg`,
        videoId
      );

      log.info({ videoId }, 'Transcode job completed successfully');
    } catch (err) {
      log.error({ videoId, err }, 'Transcode job failed');
      const message = err instanceof Error ? err.message : 'Unknown error';
      stmts.failVideo.run(`Transcoding failed: ${message}`, videoId);
      throw err; // Let BullMQ handle retry
    }
  },
  {
    connection: redisConnection,
    concurrency,
  }
);

// ── Cleanup Worker ─────────────────────────────────────────────────────
const cleanupWorker = new Worker(
  'cleanup',
  async (job) => {
    log.info('Running cleanup job');
    const result = await runFullCleanup(STREAMS_DIR, UPLOADS_DIR);
    log.info(result, 'Cleanup job completed');
    return result;
  },
  {
    connection: redisConnection,
    concurrency: 1,
  }
);

// ── Event Listeners ────────────────────────────────────────────────────
transcodeWorker.on('completed', (job) => {
  log.info({ jobId: job?.id }, 'Transcode job completed');
});

transcodeWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'Transcode job failed');
});

cleanupWorker.on('completed', (job) => {
  log.info({ jobId: job?.id }, 'Cleanup job completed');
});

// ── Graceful Shutdown ──────────────────────────────────────────────────
async function shutdown() {
  log.info('Worker shutting down...');
  await transcodeWorker.close();
  await cleanupWorker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log.info({ concurrency }, 'Worker started and listening for jobs');
