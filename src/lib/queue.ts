import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import os from 'os';
import { createChildLogger } from './logger.js';

const log = createChildLogger('queue');

const isProduction = process.env.NODE_ENV === 'production';
const hasExplicitRedis = !!process.env.REDIS_URL;

// Disable the queue by default in production if no explicit Redis URL is provided,
// or if manually disabled via QUEUE_ENABLED=false
export const QUEUE_ENABLED = process.env.QUEUE_ENABLED === 'true' || 
  (process.env.QUEUE_ENABLED !== 'false' && (!isProduction || hasExplicitRedis));

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export let connection: Redis | null = null;
export let transcodeQueue: Queue | null = null;
export let cleanupQueue: Queue | null = null;

if (QUEUE_ENABLED) {
  log.info('Queue enabled, initializing Redis connection...');
  connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      if (times > 3) {
        log.warn('Redis connection failed permanently. Queue features disabled.');
        return null;
      }
      return 1000;
    }
  });

  connection.on('error', (err: any) => {
    if (err.code !== 'ECONNREFUSED') {
      log.error({ err }, 'Redis connection error');
    }
  });

  transcodeQueue = new Queue('transcode', {
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

  cleanupQueue = new Queue('cleanup', { connection });

  cleanupQueue.on('error', (err: any) => {
    if (err.code !== 'ECONNREFUSED') log.error({ err }, 'Cleanup queue error');
  });
} else {
  log.warn('Queue is disabled. Falling back to direct processing.');
}

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
  if (!transcodeQueue) throw new Error('Queue is disabled');
  const job = await transcodeQueue.add('transcode-video', data, {
    jobId: `transcode-${data.videoId}`,
  });
  log.info({ videoId: data.videoId, jobId: job.id }, 'Transcode job enqueued');
  return job;
}

// ── Schedule cleanup job ──────────────────────────────────────────────
export async function scheduleCleanup() {
  if (!cleanupQueue) return;
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
  if (!transcodeQueue) return { waiting: 0, active: 0, completed: 0, failed: 0 };
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
  if (transcodeQueue) await transcodeQueue.close();
  if (cleanupQueue) await cleanupQueue.close();
  log.info('Queues closed');
}

export { connection as redisConnection };
