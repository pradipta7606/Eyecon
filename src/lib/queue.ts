import { Queue, Worker, Job } from 'bullmq';
import os from 'os';
import { createChildLogger } from './logger.js';

const log = createChildLogger('queue');

// ── Redis connection config ────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const redisConnection = parseRedisUrl(REDIS_URL);

// ── Queue Definitions ──────────────────────────────────────────────────
export const transcodeQueue = new Queue('transcode', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const cleanupQueue = new Queue('cleanup', {
  connection: redisConnection,
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

export { redisConnection };
