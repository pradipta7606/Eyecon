import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { stmts } from './db.js';
import { uploadFile, isS3Mode } from './storage.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('thumbnail');

// ── Extract thumbnail from video ───────────────────────────────────────
export async function extractThumbnail(
  videoId: string,
  inputPath: string,
  thumbnailDir: string
): Promise<string> {
  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  const outputPath = path.join(thumbnailDir, `${videoId}.jpg`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions([
        '-ss', '5', // Seek to 5 seconds
      ])
      .outputOptions([
        '-vf', 'thumbnail,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        '-q:v', '2',
      ])
      .output(outputPath)
      .on('end', async () => {
        log.info({ videoId, outputPath }, 'Thumbnail extracted');

        // Upload to S3 if needed
        if (isS3Mode()) {
          await uploadFile(outputPath, `thumbnails/${videoId}.jpg`);
        }

        const dbThumbPath = `/thumbnails/${videoId}.jpg`;
        stmts.updateThumbnail.run(dbThumbPath, videoId);
        resolve(dbThumbPath);
      })
      .on('error', (err) => {
        log.warn({ videoId, err: err.message }, 'Thumbnail extraction failed, trying fallback');
        // Fallback: try without seeking
        extractThumbnailFallback(videoId, inputPath, thumbnailDir)
          .then(resolve)
          .catch(reject);
      })
      .run();
  });
}

// ── Fallback: extract from first frame ─────────────────────────────────
function extractThumbnailFallback(
  videoId: string,
  inputPath: string,
  thumbnailDir: string
): Promise<string> {
  const outputPath = path.join(thumbnailDir, `${videoId}.jpg`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        '-q:v', '2',
      ])
      .output(outputPath)
      .on('end', async () => {
        log.info({ videoId }, 'Thumbnail extracted (fallback)');
        if (isS3Mode()) {
          await uploadFile(outputPath, `thumbnails/${videoId}.jpg`);
        }
        const dbThumbPath = `/thumbnails/${videoId}.jpg`;
        stmts.updateThumbnail.run(dbThumbPath, videoId);
        resolve(dbThumbPath);
      })
      .on('error', (err) => {
        log.error({ videoId, err: err.message }, 'Thumbnail fallback also failed');
        reject(err);
      })
      .run();
  });
}
