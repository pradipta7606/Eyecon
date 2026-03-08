import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { stmts } from './db.js';
import { uploadDirectory, uploadFile, isS3Mode } from './storage.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('transcoder');

// ── Production ABR Ladder ──────────────────────────────────────────────
const ABR_LADDER = [
  { name: '144p', width: 256, height: 144, bitrate: '150k', maxrate: '200k', bufsize: '300k', profile: 'baseline' },
  { name: '240p', width: 426, height: 240, bitrate: '300k', maxrate: '400k', bufsize: '600k', profile: 'main' },
  { name: '360p', width: 640, height: 360, bitrate: '600k', maxrate: '800k', bufsize: '1200k', profile: 'main' },
  { name: '480p', width: 848, height: 480, bitrate: '1000k', maxrate: '1500k', bufsize: '2000k', profile: 'main' },
  { name: '720p', width: 1280, height: 720, bitrate: '2500k', maxrate: '3500k', bufsize: '5000k', profile: 'high' },
  { name: '1080p', width: 1920, height: 1080, bitrate: '4500k', maxrate: '6000k', bufsize: '8000k', profile: 'high' },
];

const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || '4', 10);

// ── Probe video metadata ──────────────────────────────────────────────
export function probeVideo(inputPath: string): Promise<{
  duration: number;
  codec: string;
  width: number;
  height: number;
  fileSize: number;
  hasAudio: boolean;
}> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
      const duration = metadata.format.duration || 0;
      const fileSize = metadata.format.size || 0;

      resolve({
        duration,
        codec: videoStream?.codec_name || 'unknown',
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        fileSize: typeof fileSize === 'string' ? parseInt(fileSize, 10) : fileSize,
        hasAudio,
      });
    });
  });
}

// ── Determine which variants to encode ─────────────────────────────────
function selectVariants(sourceHeight: number) {
  // Only encode variants at or below source resolution
  return ABR_LADDER.filter(v => v.height <= sourceHeight || v.height <= 360);
  // Always include at least up to 360p for very low-res sources
}

// ── Main transcode function ────────────────────────────────────────────
export async function transcodeVideo(
  videoId: string,
  inputPath: string,
  outputDir: string,
  onProgress?: (percent: number, detail: string) => void
): Promise<void> {
  log.info({ videoId, inputPath, outputDir }, 'Starting transcode');

  // Phase 1: Probe
  onProgress?.(5, 'Probing video metadata');
  let probeData;
  try {
    probeData = await probeVideo(inputPath);
    stmts.updateMetadata.run(probeData.duration, probeData.codec, probeData.fileSize, videoId);
    log.info({ videoId, ...probeData }, 'Probe completed');
  } catch (err) {
    log.error({ videoId, err }, 'Probe failed');
    stmts.failVideo.run('Failed to probe video file', videoId);
    throw err;
  }

  // Phase 2: Select variants
  const variants = selectVariants(probeData.height);
  log.info({ videoId, variants: variants.map(v => v.name) }, 'Selected encoding variants');

  // Phase 3: Create output directories
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  for (const variant of variants) {
    const vDir = path.join(outputDir, variant.name);
    if (!fs.existsSync(vDir)) fs.mkdirSync(vDir, { recursive: true });
  }

  // Phase 4: Build FFmpeg command
  onProgress?.(10, `Encoding ${variants.length} quality variants`);

  await new Promise<void>((resolve, reject) => {
    // Build filter complex for splitting and scaling
    const splitCount = variants.length;
    const splitOutputs = variants.map((_, i) => `[v${i}]`).join('');
    let filterComplex = `[0:v]split=${splitCount}${splitOutputs};`;

    variants.forEach((v, i) => {
      filterComplex += `[v${i}]scale=w=${v.width}:h=${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v${i}out]`;
      if (i < variants.length - 1) filterComplex += ';';
    });

    const command = ffmpeg(inputPath)
      .inputOptions([
        '-reconnect 1',
        '-reconnect_streamed 1',
        '-reconnect_delay_max 5',
        '-probesize 50M',
        '-analyzeduration 50M',
      ]);

    // Build output options
    const outputOpts: string[] = ['-filter_complex', filterComplex];

    // Map video streams with per-variant encoding settings
    variants.forEach((v, i) => {
      outputOpts.push('-map', `[v${i}out]`);
    });

    // Map audio streams if present
    if (probeData.hasAudio) {
      variants.forEach(() => {
        outputOpts.push('-map', '0:a');
      });
    }

    // Per-variant video encoding settings
    variants.forEach((v, i) => {
      outputOpts.push(
        `-c:v:${i}`, 'libx264',
        `-b:v:${i}`, v.bitrate,
        `-maxrate:v:${i}`, v.maxrate,
        `-bufsize:v:${i}`, v.bufsize,
        `-profile:v:${i}`, v.profile,
      );
    });

    // Global encoding settings for keyframe alignment
    outputOpts.push(
      '-preset', 'veryfast',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
    );

    // Audio encoding
    if (probeData.hasAudio) {
      outputOpts.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    }

    // HLS settings
    const varStreamMap = variants.map((v, i) => {
      return probeData.hasAudio ? `v:${i},a:${i},name:${v.name}` : `v:${i},name:${v.name}`;
    }).join(' ');

    outputOpts.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(outputDir, '%v/seg_%03d.ts'),
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', varStreamMap,
    );

    command
      .outputOptions(outputOpts)
      .output(path.join(outputDir, '%v/index.m3u8'))
      .on('start', (cmdLine) => {
        log.info({ videoId, command: cmdLine.substring(0, 200) }, 'FFmpeg started');
        onProgress?.(12, 'FFmpeg encoding started');
      })
      .on('progress', (progress) => {
        const percent = Math.min(90, 12 + (progress.percent || 0) * 0.78);
        onProgress?.(percent, `Encoding HLS segments (${Math.round(progress.percent || 0)}%)`);
      })
      .on('end', () => {
        log.info({ videoId }, 'FFmpeg encoding completed');
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        log.error({ videoId, err: err.message, stderr: stderr?.substring(0, 500) }, 'FFmpeg error');
        reject(err);
      })
      .run();
  });

  // Phase 5: Register streams in DB
  onProgress?.(92, 'Registering stream variants');
  for (const v of variants) {
    const playlistPath = `/streams/${videoId}/${v.name}/index.m3u8`;
    stmts.insertStream.run(
      videoId, v.name, v.width, v.height,
      parseInt(v.bitrate.replace('k', '')) * 1000,
      playlistPath
    );
  }

  // Phase 6: Upload to object storage if S3 mode
  if (isS3Mode()) {
    onProgress?.(94, 'Uploading segments to object storage');
    await uploadDirectory(outputDir, `streams/${videoId}`);
    log.info({ videoId }, 'Segments uploaded to object storage');
  }

  onProgress?.(98, 'Transcode pipeline complete');
  log.info({ videoId, variants: variants.length }, 'Transcode completed successfully');
}
