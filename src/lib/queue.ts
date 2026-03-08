import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import os from 'os';
import { createChildLogger } from './logger.js';

const log = createChildLogger('queue');

// ── Redis connection config ────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    if (times > 3) {
      log.warn('Redis connection failed permanently. Queue features will be disabled.');
      return null; // Stop retrying
    }
    return 1000; // wait 1s between retries
  }
});

connection.on('error', (err: any) => {
  // Suppress ECONNREFUSED spam if Redis is intentionaly not running
  if (err.code !== 'ECONNREFUSED') {
    log.error({ err }, 'Redis connection error');
  }
});

// ── Queue Definitions ──────────────────────────────────────────────────
export const transcodeQueue = new Queue('transcode', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

transcodeQueue.on('error', (err: any) => {
  if (err.code !== 'ECONNREFUSED') log.error({ err }, 'Transcode queue error');
});

export const cleanupQueue = new Queue('cleanup', {
  connection,
});

cleanupQueue.on('error', (err: any) => {
  if (err.code !== 'ECONNREFUSED') log.error({ err }, 'Cleanup queue error');
});

// ── Dynamic concurrency ────────────────────────────────────────────────
export function getOptimalConcurrency(): number {
  const cpuCount = os.cpus().length;
  const concurrency = Math.max(1, Math.floor(cpuCount / 2));
  log.info({ cpuCount, concurrency }, 'Calculated optimal concurrency');
  return parseInt(process.env.QUEUE_CONCURRENCY || String(concurrency), 10);
}

// ── Add transcode job ──────────────────────────────────────────────────
export async function addTranscodeJob(data: {
  videoId: string;
  inputPath: string;
  outputDir: string;
  thumbnailDir: string;
}) {
  const job = await transcodeQueue.add('transcode-video', data, {
    jobId: `transcode-${data.videoId}`,
  });
  log.info({ videoId: data.videoId, jobId: job.id }, 'Transcode job enqueued');
  return job;
}

// ── Schedule cleanup job ──────────────────────────────────────────────
export async function scheduleCleanup() {
  const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '6', 10);
  await cleanupQueue.add(
    'cleanup-storage',
    {},
    {
      repeat: { every: intervalHours * 60 * 60 * 1000 },
      jobId: 'scheduled-cleanup',
    }
  );
  log.info({ intervalHours }, 'Cleanup job scheduled');
}

// ── Get queue stats ────────────────────────────────────────────────────
export async function getQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    transcodeQueue.getWaitingCount(),
    transcodeQueue.getActiveCount(),
    transcodeQueue.getCompletedCount(),
    transcodeQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

// ── Graceful shutdown ──────────────────────────────────────────────────
export async function closeQueues() {
  await transcodeQueue.close();
  await cleanupQueue.close();
  log.info('Queues closed');
}

export { connection as redisConnection };
