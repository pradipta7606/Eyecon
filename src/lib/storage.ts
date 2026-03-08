import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from './logger.js';

const log = createChildLogger('storage');

// ── Configuration ──────────────────────────────────────────────────────
const STORAGE_MODE = process.env.STORAGE_MODE || 'local'; // 'local' | 's3'
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'eyecon';
const MINIO_REGION = process.env.MINIO_REGION || 'us-east-1';

// ── S3 Client (MinIO compatible) ───────────────────────────────────────
let s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: MINIO_REGION,
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }
  return s3;
}

// ── Ensure bucket exists ───────────────────────────────────────────────
export async function ensureBucket(): Promise<void> {
  if (STORAGE_MODE === 'local') return;
  const client = getS3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET }));
    log.info({ bucket: MINIO_BUCKET }, 'Bucket exists');
  } catch {
    log.info({ bucket: MINIO_BUCKET }, 'Creating bucket');
    await client.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
  }
}

// ── Upload a directory recursively ─────────────────────────────────────
export async function uploadDirectory(
  localDir: string,
  remotePrefix: string
): Promise<void> {
  if (STORAGE_MODE === 'local') return;

  const client = getS3Client();
  const files = getAllFiles(localDir);

  for (const filePath of files) {
    const relativePath = path.relative(localDir, filePath).replace(/\\/g, '/');
    const key = `${remotePrefix}/${relativePath}`;
    const body = fs.readFileSync(filePath);
    const contentType = getContentType(filePath);

    await client.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }
  log.info({ prefix: remotePrefix, count: files.length }, 'Uploaded directory to object storage');
}

// ── Upload a single file ───────────────────────────────────────────────
export async function uploadFile(
  localPath: string,
  remoteKey: string
): Promise<void> {
  if (STORAGE_MODE === 'local') return;

  const client = getS3Client();
  const body = fs.readFileSync(localPath);
  const contentType = getContentType(localPath);

  await client.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: remoteKey,
      Body: body,
      ContentType: contentType,
    })
  );
  log.info({ key: remoteKey }, 'Uploaded file to object storage');
}

// ── Delete all objects under a prefix ──────────────────────────────────
export async function deletePrefix(prefix: string): Promise<void> {
  if (STORAGE_MODE === 'local') return;

  const client = getS3Client();
  let continuationToken: string | undefined;

  do {
    const listResult = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = listResult.Contents;
    if (objects && objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: MINIO_BUCKET,
          Delete: {
            Objects: objects.map((obj) => ({ Key: obj.Key })),
          },
        })
      );
    }
    continuationToken = listResult.NextContinuationToken;
  } while (continuationToken);

  log.info({ prefix }, 'Deleted all objects under prefix');
}

// ── Check if storage is S3 mode ────────────────────────────────────────
export function isS3Mode(): boolean {
  return STORAGE_MODE === 's3';
}

export function getStorageMode(): string {
  return STORAGE_MODE;
}

// ── Helpers ────────────────────────────────────────────────────────────
function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.m4s': 'video/iso.segment',
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  return types[ext] || 'application/octet-stream';
}
