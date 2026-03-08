# Eyecon — Production Adaptive Streaming Platform

A production-grade, research-oriented real-time adaptive video streaming platform that replicates the core architectural behavior of large-scale OTT services.

```
          ┌────────────────────────────────┐
          │        Client (Browser)         │
          │   HLS.js + MSE + ABR + Stats    │
          └──────────────┬─────────────────┘
                         │
          ┌──────────────▼─────────────────┐
          │        Nginx Reverse Proxy      │
          │  Static segments + Cache 1yr    │
          │  auth_request for signed URLs   │
          └───┬───────────────────────┬────┘
              │                       │
    ┌─────────▼─────────┐  ┌─────────▼─────────┐
    │    Express API     │  │   MinIO (S3)       │
    │  Upload/Auth/Stats │  │   Object Storage   │
    └─────────┬─────────┘  └────────────────────┘
              │                       ▲
    ┌─────────▼─────────┐            │
    │   Redis + BullMQ   │            │
    └─────────┬─────────┘            │
    ┌─────────▼─────────┐            │
    │  Worker (FFmpeg)   │────────────┘
    │  Transcode + Thumb │
    └───────────────────┘
```

## Features

- **6-Variant ABR Encoding**: 144p → 1080p with maxrate/bufsize, keyframe-aligned segments
- **BullMQ Job Queue**: Async transcoding via Redis, scalable workers
- **Adaptive Streaming**: HLS.js player with dynamic buffer management and ABR
- **Real-Time Analytics**: Bandwidth, buffer, quality, rebuffers, dropped frames — batched to backend
- **Signed URL Security**: HMAC-SHA256 token validation via Nginx auth_request
- **CDN-Compatible**: Immutable segment caching (1yr), short manifest cache (2s)
- **Docker Deployment**: 5-service compose stack (app, worker, redis, nginx, minio)
- **Storage Lifecycle**: Automated cleanup of failed transcodes and orphan uploads

## Prerequisites

- **Node.js 20+** and **npm**
- **FFmpeg** in PATH (for local development)
- **Redis** (optional for dev — falls back to direct transcoding)
- **Docker & Docker Compose** (for production deployment)

## Quick Start (Development)

```bash
# 1. Clone and install
git clone <repo>
cd eyecon
cp .env.example .env
npm install

# 2. Start Redis (optional, enables job queue)
# On Windows: use Docker or Redis for Windows
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 3. Start the dev server
npm run dev

# 4. Start the worker (separate terminal)
npm run dev:worker

# 5. Open http://localhost:3000
```

> **Note**: Without Redis, the server falls back to direct transcoding. The queue is recommended for production workloads.

## Docker Deployment

```bash
# Build and start all services
docker compose up --build -d

# Scale workers for parallel encoding
docker compose up -d --scale worker=4

# Enable MinIO object storage
docker compose --profile s3 up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

**Services:**

| Service | Port | Purpose |
|---------|------|---------|
| nginx | 80 | Reverse proxy + static segment serving |
| app | 3000 | Express API server |
| redis | 6379 | BullMQ job queue |
| worker | — | FFmpeg transcoding (scalable) |
| minio | 9000/9001 | S3-compatible object storage (optional) |

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | System health + queue stats |
| `GET` | `/api/stats` | Storage usage + video count |
| `GET` | `/api/videos` | List all videos with stream info |
| `GET` | `/api/videos/:id` | Single video detail + stream token |
| `POST` | `/api/upload` | Upload video file (multipart) |
| `POST` | `/api/ingest-url` | Ingest from remote URL |
| `DELETE` | `/api/videos/:id` | Delete video + all segments |
| `GET` | `/api/videos/:id/stream-token` | Generate signed stream token |
| `GET` | `/api/auth-segment` | Nginx auth_request validation |
| `POST` | `/api/analytics` | Batched player analytics events |

## ABR Encoding Ladder

| Resolution | Bitrate | Maxrate | Bufsize | Profile |
|-----------|---------|---------|---------|---------|
| 144p | 150k | 200k | 300k | baseline |
| 240p | 300k | 400k | 600k | main |
| 360p | 600k | 800k | 1200k | main |
| 480p | 1000k | 1500k | 2000k | main |
| 720p | 2500k | 3500k | 5000k | high |
| 1080p | 4500k | 6000k | 8000k | high |

All variants use: `-g 48 -keyint_min 48 -sc_threshold 0 -hls_time 4`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `REDIS_URL` | redis://localhost:6379 | Redis connection |
| `STORAGE_MODE` | local | `local` or `s3` |
| `MINIO_ENDPOINT` | http://localhost:9000 | MinIO/S3 endpoint |
| `MINIO_ACCESS_KEY` | minioadmin | S3 access key |
| `MINIO_SECRET_KEY` | minioadmin | S3 secret key |
| `SEGMENT_DURATION` | 4 | HLS segment length (seconds) |
| `QUEUE_CONCURRENCY` | CPU/2 | Parallel encoding jobs |
| `MAX_UPLOAD_SIZE_MB` | 5120 | Max upload size |
| `STREAM_SECRET` | dev-secret | HMAC signing key |
| `LOG_LEVEL` | info | Pino log level |
| `CLEANUP_INTERVAL_HOURS` | 6 | Cleanup job interval |

## Player Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±10 seconds |
| `↑` / `↓` | Volume ±10% |
| `F` | Toggle fullscreen |
| `M` | Toggle mute |
| `1`-`9` | Seek to 10%-90% |

## Storage Layout

```
streams/<video_id>/
    master.m3u8
    144p/index.m3u8 + seg_000.ts...
    240p/...
    360p/...
    480p/...
    720p/...
    1080p/...

thumbnails/<video_id>.jpg
uploads/<video_id>.mp4
```

## License

MIT
