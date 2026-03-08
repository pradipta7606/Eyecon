import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import db, { stmts, type VideoRecord, type StreamRecord } from './src/lib/db.js';
import { addTranscodeJob, getQueueStats, scheduleCleanup, closeQueues } from './src/lib/queue.js';
import { generateStreamToken, validateStreamToken, extractVideoIdFromPath } from './src/lib/security.js';
import { ensureBucket } from './src/lib/storage.js';
import logger, { createChildLogger } from './src/lib/logger.js';

const log = createChildLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const STREAMS_DIR = path.resolve(__dirname, 'streams');
const THUMBNAILS_DIR = path.resolve(__dirname, 'thumbnails');
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5120', 10) * 1024 * 1024;

// Ensure directories exist
[UPLOADS_DIR, STREAMS_DIR, THUMBNAILS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Multer storage ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const id = uuidv4();
    cb(null, `${id}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = /^video\//;
    if (allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
});

// ── Rate Limiters ──────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads, please try again later' },
});

// ── Start Server ───────────────────────────────────────────────────────
async function startServer() {
  const app = express();
  
  // Enable CORS to allow the Vercel frontend to access this Render backend
  app.use(cors());

  // Ensure storage bucket exists
  try {
    await ensureBucket();
  } catch (err) {
    log.warn({ err }, 'MinIO not available, using local storage');
  }

  // Schedule cleanup jobs
  try {
    await scheduleCleanup();
  } catch (err) {
    log.warn({ err }, 'Failed to schedule cleanup (Redis may not be available)');
  }

  app.use(express.json());
  app.use(generalLimiter);

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (!req.path.startsWith('/streams/') && !req.path.startsWith('/thumbnails/') && !req.path.includes('.')) {
        log.info({ method: req.method, path: req.path, status: res.statusCode, duration }, 'request');
      }
    });
    next();
  });

  // ── API: Health Check ──────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    let queueStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
      queueStats = await getQueueStats();
    } catch { /* Redis not available */ }

    res.json({
      status: 'ok',
      storage: fs.existsSync(STREAMS_DIR),
      db: !!db,
      queue: queueStats,
      uptime: process.uptime(),
    });
  });

  // ── API: System Stats ──────────────────────────────────────────────
  app.get('/api/stats', async (_req, res) => {
    let queueStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
      queueStats = await getQueueStats();
    } catch { /* Redis not available */ }

    // Calculate storage usage
    let storageBytes = 0;
    try {
      storageBytes = getDirSize(STREAMS_DIR) + getDirSize(UPLOADS_DIR) + getDirSize(THUMBNAILS_DIR);
    } catch { /* ignore */ }

    const videoCount = (db.prepare('SELECT COUNT(*) as count FROM videos').get() as any)?.count || 0;

    res.json({
      videos: videoCount,
      queue: queueStats,
      storage: {
        bytes: storageBytes,
        formatted: formatBytes(storageBytes),
      },
    });
  });

  // ── API: Get all videos ────────────────────────────────────────────
  app.get('/api/videos', (_req, res) => {
    const videos = stmts.getAllVideos.all() as VideoRecord[];

    // Attach stream info to each video
    const enriched = videos.map(v => {
      const streams = stmts.getStreams.all(v.id) as StreamRecord[];
      return {
        ...v,
        streams,
        resolutions: streams.map(s => s.resolution),
      };
    });

    res.json(enriched);
  });

  // ── API: Get single video ──────────────────────────────────────────
  app.get('/api/videos/:id', (req, res) => {
    const video = stmts.getVideo.get(req.params.id) as VideoRecord | undefined;
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const streams = stmts.getStreams.all(video.id) as StreamRecord[];
    const streamToken = generateStreamToken(video.id);

    res.json({
      ...video,
      streams,
      resolutions: streams.map(s => s.resolution),
      streamToken,
    });
  });

  // ── API: Generate stream token ─────────────────────────────────────
  app.get('/api/videos/:id/stream-token', (req, res) => {
    const video = stmts.getVideo.get(req.params.id) as VideoRecord | undefined;
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const token = generateStreamToken(video.id);
    res.json(token);
  });

  // ── API: Validate segment access (Nginx auth_request) ─────────────
  app.get('/api/auth-segment', (req, res) => {
    const { token, expires, path: streamPath } = req.query;

    if (!token || !expires || !streamPath) {
      return res.status(403).json({ error: 'Missing auth parameters' });
    }

    const videoId = extractVideoIdFromPath(streamPath as string);
    if (!videoId) {
      return res.status(403).json({ error: 'Invalid stream path' });
    }

    const isValid = validateStreamToken(videoId, token as string, expires as string);
    if (isValid) {
      res.status(200).json({ ok: true });
    } else {
      res.status(403).json({ error: 'Invalid or expired token' });
    }
  });

  // ── API: Upload video file ─────────────────────────────────────────
  app.post('/api/upload', uploadLimiter, upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const videoId = path.parse(req.file.filename).name;
    const title = req.body.title || req.file.originalname;
    const fileSize = req.file.size;

    stmts.insertVideo.run(videoId, title, req.file.filename, 'upload', fileSize);

    // Enqueue transcoding job
    const inputPath = req.file.path;
    const outputDir = path.join(STREAMS_DIR, videoId);

    try {
      await addTranscodeJob({ videoId, inputPath, outputDir, thumbnailDir: THUMBNAILS_DIR });
    } catch (err) {
      // If Redis is not available, fall back to direct transcoding
      log.warn({ err }, 'Queue unavailable, falling back to direct transcoding');
      const { transcodeVideo } = await import('./src/lib/transcoder.js');
      const { extractThumbnail } = await import('./src/lib/thumbnail.js');

      stmts.updateStatus.run('processing', 'Direct processing (no queue)', 5, videoId);

      transcodeVideo(videoId, inputPath, outputDir, (percent, detail) => {
        stmts.updateStatus.run('processing', detail, percent, videoId);
      })
        .then(async () => {
          try { await extractThumbnail(videoId, inputPath, THUMBNAILS_DIR); } catch {}
          stmts.completeVideo.run('Transcoding complete', `/thumbnails/${videoId}.jpg`, videoId);
        })
        .catch((e) => {
          stmts.failVideo.run(`Transcoding failed: ${e.message}`, videoId);
        });
    }

    res.json({ id: videoId, status: 'pending' });
  });

  // ── API: Ingest from URL ───────────────────────────────────────────
  // ── API: Ingest from URL ───────────────────────────────────────────
  app.post('/api/ingest-url', uploadLimiter, async (req, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    const videoId = uuidv4();
    const videoTitle = title || 'Remote Stream';

    // Instead of queueing a transcode job, we just save the URL and mark it ready to play instantly.
    stmts.insertVideo.run(videoId, videoTitle, url, 'url', null);
    stmts.completeVideo.run('Ready to play', null, videoId);

    res.json({ id: videoId, status: 'completed' });
  });

  // ── API: Delete video ──────────────────────────────────────────────
  app.delete('/api/videos/:id', async (req, res) => {
    const video = stmts.getVideo.get(req.params.id) as VideoRecord | undefined;
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Delete from database (cascading deletes streams)
    stmts.deleteStreams.run(video.id);
    stmts.deleteVideo.run(video.id);

    // Delete local files
    const streamDir = path.join(STREAMS_DIR, video.id);
    if (fs.existsSync(streamDir)) {
      fs.rmSync(streamDir, { recursive: true, force: true });
    }

    // Delete upload file
    if (video.source_type === 'upload') {
      const uploadPath = path.join(UPLOADS_DIR, video.filename);
      if (fs.existsSync(uploadPath)) {
        fs.unlinkSync(uploadPath);
      }
    }

    // Delete thumbnail
    const thumbPath = path.join(THUMBNAILS_DIR, `${video.id}.jpg`);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }

    // Delete from S3 if applicable
    try {
      const { deletePrefix } = await import('./src/lib/storage.js');
      await deletePrefix(`streams/${video.id}`);
      await deletePrefix(`thumbnails/${video.id}`);
    } catch { /* ignore */ }

    log.info({ videoId: video.id }, 'Video deleted');
    res.json({ ok: true });
  });

  // ── API: Batched analytics ─────────────────────────────────────────
  app.post('/api/analytics', (req, res) => {
    const { videoId, sessionId, events } = req.body;
    if (!videoId || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid analytics payload' });
    }

    const insertMany = db.transaction((evts: any[]) => {
      for (const evt of evts) {
        stmts.insertAnalytics.run(
          videoId,
          sessionId || null,
          evt.type || 'unknown',
          JSON.stringify(evt.data || {})
        );
      }
    });

    try {
      insertMany(events);
      res.json({ ok: true, received: events.length });
    } catch (err) {
      log.error({ err }, 'Analytics insert error');
      res.status(500).json({ error: 'Failed to store analytics' });
    }
  });

  // ── Serve stream files with caching headers ────────────────────────
  app.use('/streams', (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();

    if (ext === '.ts' || ext === '.m4s') {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (ext === '.m3u8') {
      res.setHeader('Cache-Control', 'public, max-age=2');
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

    next();
  }, express.static(STREAMS_DIR, {
    acceptRanges: true,
    etag: true,
  }));

  // ── Serve thumbnails ───────────────────────────────────────────────
  app.use('/thumbnails', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  }, express.static(THUMBNAILS_DIR));

  // ── Error handling middleware ───────────────────────────────────────
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max size: ${process.env.MAX_UPLOAD_SIZE_MB || 5120}MB` });
      }
      return res.status(400).json({ error: err.message });
    }

    log.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Vite / Static serving ──────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  // ── Start ──────────────────────────────────────────────────────────
  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info({ port: PORT }, `Eyecon server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  async function shutdown() {
    log.info('Server shutting down...');
    server.close();
    try { await closeQueues(); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── Utilities ──────────────────────────────────────────────────────────
function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

startServer();
