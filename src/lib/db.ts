import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { createChildLogger } from './logger.js';

const log = createChildLogger('database');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../../videos.db');

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    source_type TEXT DEFAULT 'upload',
    duration REAL,
    codec TEXT,
    file_size INTEGER,
    status TEXT DEFAULT 'pending',
    status_detail TEXT,
    progress REAL DEFAULT 0,
    thumbnail_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    resolution TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bitrate INTEGER,
    playlist_path TEXT,
    UNIQUE(video_id, resolution)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Migration: handle old schema ───────────────────────────────────────
try {
  const columns = db.prepare("PRAGMA table_info(videos)").all() as { name: string }[];
  const columnNames = columns.map(c => c.name);

  if (!columnNames.includes('source_type')) {
    db.exec("ALTER TABLE videos ADD COLUMN source_type TEXT DEFAULT 'upload'");
    log.info('Migrated: added source_type column');
  }
  if (!columnNames.includes('codec')) {
    db.exec('ALTER TABLE videos ADD COLUMN codec TEXT');
    log.info('Migrated: added codec column');
  }
  if (!columnNames.includes('file_size')) {
    db.exec('ALTER TABLE videos ADD COLUMN file_size INTEGER');
    log.info('Migrated: added file_size column');
  }
  if (!columnNames.includes('thumbnail_path')) {
    db.exec('ALTER TABLE videos ADD COLUMN thumbnail_path TEXT');
    log.info('Migrated: added thumbnail_path column');
  }
  // Remove old columns that are now in streams table
  // SQLite doesn't support DROP COLUMN before 3.35, so we just leave them
} catch (err) {
  log.warn({ err }, 'Migration check completed with warnings');
}

log.info({ path: dbPath }, 'Database initialized');

// ── Prepared Statements ────────────────────────────────────────────────
export const stmts = {
  insertVideo: db.prepare(`
    INSERT INTO videos (id, title, filename, source_type, file_size)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateStatus: db.prepare(`
    UPDATE videos SET status = ?, status_detail = ?, progress = ? WHERE id = ?
  `),
  updateMetadata: db.prepare(`
    UPDATE videos SET duration = ?, codec = ?, file_size = ? WHERE id = ?
  `),
  updateThumbnail: db.prepare(`
    UPDATE videos SET thumbnail_path = ? WHERE id = ?
  `),
  completeVideo: db.prepare(`
    UPDATE videos SET status = 'completed', status_detail = ?, progress = 100,
    thumbnail_path = ? WHERE id = ?
  `),
  failVideo: db.prepare(`
    UPDATE videos SET status = 'failed', status_detail = ? WHERE id = ?
  `),
  getVideo: db.prepare('SELECT * FROM videos WHERE id = ?'),
  getAllVideos: db.prepare('SELECT * FROM videos ORDER BY created_at DESC'),
  deleteVideo: db.prepare('DELETE FROM videos WHERE id = ?'),
  insertStream: db.prepare(`
    INSERT OR REPLACE INTO streams (video_id, resolution, width, height, bitrate, playlist_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getStreams: db.prepare('SELECT * FROM streams WHERE video_id = ?'),
  deleteStreams: db.prepare('DELETE FROM streams WHERE video_id = ?'),
  getFailedVideos: db.prepare(
    "SELECT * FROM videos WHERE status = 'failed' AND created_at < datetime('now', ?)"
  ),
  getPendingVideos: db.prepare(
    "SELECT * FROM videos WHERE status = 'pending' AND created_at < datetime('now', ?)"
  ),
  insertAnalytics: db.prepare(`
    INSERT INTO analytics (video_id, session_id, event_type, event_data)
    VALUES (?, ?, ?, ?)
  `),
};

export interface VideoRecord {
  id: string;
  title: string;
  filename: string;
  source_type: string;
  duration: number | null;
  codec: string | null;
  file_size: number | null;
  status: string;
  status_detail: string | null;
  progress: number;
  thumbnail_path: string | null;
  created_at: string;
}

export interface StreamRecord {
  id: number;
  video_id: string;
  resolution: string;
  width: number;
  height: number;
  bitrate: number;
  playlist_path: string;
}

export default db;
