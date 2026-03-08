import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  Settings, Activity, Check, Gauge, PictureInPicture2,
  Loader2, BarChart3, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface PlayerProps {
  src: string;
  title: string;
}

interface PlayerStats {
  bandwidth: number;
  bufferLen: number;
  level: number;
  levelName: string;
  latency: number;
  droppedFrames: number;
  rebufferCount: number;
  bitrateHistory: { time: number; level: string }[];
  downloadTime: number;
  segmentsLoaded: number;
}

// ── Analytics buffer for batched reporting ──────────────────────────────
class AnalyticsBuffer {
  private events: { type: string; data: any; timestamp: number }[] = [];
  private videoId: string;
  private sessionId: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(videoId: string) {
    this.videoId = videoId;
    this.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  push(type: string, data: any = {}) {
    this.events.push({ type, data, timestamp: Date.now() });
  }

  start() {
    this.timer = setInterval(() => this.flush(), 30000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  private async flush() {
    if (this.events.length === 0) return;
    const batch = [...this.events];
    this.events = [];

    try {
      await fetch(`${API_BASE}/api/analytics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: this.videoId,
          sessionId: this.sessionId,
          events: batch,
        }),
      });
    } catch {
      // Re-add events if flush fails
      this.events.unshift(...batch);
    }
  }
}

export const Player: React.FC<PlayerProps> = ({ src, title }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const analyticsRef = useRef<AnalyticsBuffer | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPiP, setIsPiP] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [levels, setLevels] = useState<{ id: number; height: number; bitrate: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [stats, setStats] = useState<PlayerStats>({
    bandwidth: 0,
    bufferLen: 0,
    level: 0,
    levelName: 'Auto',
    latency: 0,
    droppedFrames: 0,
    rebufferCount: 0,
    bitrateHistory: [],
    downloadTime: 0,
    segmentsLoaded: 0,
  });

  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // ── Extract videoId from src for analytics ─────────────────────────
  const extractVideoId = useCallback((streamSrc: string) => {
    const match = streamSrc.match(/\/streams\/([a-f0-9-]+)\//i);
    return match ? match[1] : 'unknown';
  }, []);

  // ── Initialize HLS ────────────────────────────────────────────────
  useEffect(() => {
    if (!videoRef.current) return;

    const video = videoRef.current;
    let hls: Hls | null = null;

    // Start analytics
    const videoId = extractVideoId(src);
    const analytics = new AnalyticsBuffer(videoId);
    analyticsRef.current = analytics;
    analytics.start();
    analytics.push('playback_start', { src });

    const isM3U8 = src.toLowerCase().includes('.m3u8') || src.toLowerCase().includes('manifest');

    if (isM3U8 && Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 10,
        maxBufferHole: 0.5,
        lowLatencyMode: false,
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthUpFactor: 0.7,
        abrBandWidthFactor: 0.95,
        testBandwidth: true,
        startLevel: -1,
      });

      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        setLevels(data.levels.map((l, i) => ({
          id: i,
          height: l.height,
          bitrate: l.bitrate,
        })));
        setIsLoading(false);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const levelInfo = hls?.levels[data.level];
        const levelName = levelInfo ? `${levelInfo.height}p` : 'Auto';
        setStats(prev => ({
          ...prev,
          level: data.level,
          levelName,
          bitrateHistory: [
            ...prev.bitrateHistory.slice(-19),
            { time: Date.now(), level: levelName },
          ],
        }));
        analytics.push('bitrate_switch', { level: data.level, name: levelName });
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const downloadTime = data.frag.stats.loading.end - data.frag.stats.loading.start;
        setStats(prev => ({
          ...prev,
          downloadTime: Math.round(downloadTime),
          segmentsLoaded: prev.segmentsLoaded + 1,
        }));
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setStats(prev => ({
          ...prev,
          bufferLen: video.buffered.length > 0
            ? video.buffered.end(video.buffered.length - 1) - video.currentTime
            : 0,
          bandwidth: Math.round((hls?.bandwidthEstimate || 0) / 1000),
        }));
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.details === 'bufferStalledError') {
          setStats(prev => ({ ...prev, rebufferCount: prev.rebufferCount + 1 }));
          analytics.push('rebuffer', { time: video.currentTime });
        }

        if (data.fatal) {
          analytics.push('error', { type: data.type, details: data.details });
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError();
              break;
            default:
              hls?.destroy();
              break;
          }
        }
      });
    } else if (isM3U8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      setIsLoading(false);
    } else {
      // Not an HLS stream, playback natively (e.g. MP4)
      video.src = src;
      setIsLoading(false);
    }

    return () => {
      analytics.stop();
      if (hls) hls.destroy();
    };
  }, [src, extractVideoId]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const video = videoRef.current;
      if (!video) return;

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'arrowright':
          e.preventDefault();
          video.currentTime = Math.min(video.duration, video.currentTime + 10);
          break;
        case 'arrowup':
          e.preventDefault();
          setVolume(v => {
            const nv = Math.min(1, v + 0.1);
            if (video) video.volume = nv;
            return nv;
          });
          break;
        case 'arrowdown':
          e.preventDefault();
          setVolume(v => {
            const nv = Math.max(0, v - 0.1);
            if (video) video.volume = nv;
            return nv;
          });
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          toggleMute();
          break;
        default:
          // 1-9: seek to percentage
          const num = parseInt(e.key);
          if (num >= 1 && num <= 9) {
            video.currentTime = (video.duration * num) / 10;
          }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isPlaying]);

  // ── Fullscreen change listener ─────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Auto-hide controls ─────────────────────────────────────────────
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [isPlaying]);

  // ── Player actions ─────────────────────────────────────────────────
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else videoRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  };

  const togglePiP = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiP(false);
      } else {
        await videoRef.current.requestPictureInPicture();
        setIsPiP(true);
      }
    } catch { /* PiP not supported */ }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    setProgress((video.currentTime / video.duration) * 100);

    // Update buffered ranges for visualization
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push({
        start: (video.buffered.start(i) / video.duration) * 100,
        end: (video.buffered.end(i) / video.duration) * 100,
      });
    }
    setBufferedRanges(ranges);

    // Update dropped frames
    const quality = (video as any).getVideoPlaybackQuality?.();
    if (quality) {
      setStats(prev => ({ ...prev, droppedFrames: quality.droppedVideoFrames || 0 }));
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    videoRef.current.currentTime = (percent / 100) * videoRef.current.duration;
    setProgress(percent);
  };

  const handleSeekHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = ((e.clientX - rect.left) / rect.width) * 100;
    setHoverTime((percent / 100) * videoRef.current.duration);
    setHoverX(e.clientX - rect.left);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      setIsMuted(val === 0);
    }
  };

  const selectLevel = (levelId: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelId;
      setCurrentLevel(levelId);
      setShowSettings(false);
      analyticsRef.current?.push('quality_manual', { level: levelId });
    }
  };

  const setSpeed = (speed: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
      setPlaybackRate(speed);
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={containerRef}
      className="relative group bg-black rounded-xl overflow-hidden shadow-2xl border border-white/10"
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      <video
        ref={videoRef}
        className="w-full aspect-video cursor-pointer"
        onTimeUpdate={handleTimeUpdate}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => { setIsPlaying(true); setIsLoading(false); }}
        onPause={() => setIsPlaying(false)}
        onWaiting={() => setIsLoading(true)}
        onCanPlay={() => setIsLoading(false)}
      />

      {/* Loading Spinner */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center bg-black/30 z-20 pointer-events-none"
          >
            <Loader2 size={48} className="text-emerald-500 animate-spin" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Play button overlay when paused */}
      {!isPlaying && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="w-20 h-20 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center">
            <Play size={36} className="text-white ml-1" fill="currentColor" />
          </div>
        </div>
      )}

      {/* Analytics Overlay */}
      <AnimatePresence>
        {showAnalytics && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="absolute top-4 right-4 w-72 bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-4 z-30 text-xs font-mono"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-emerald-500 font-bold tracking-widest uppercase text-[10px]">Stream Analytics</span>
              <button onClick={() => setShowAnalytics(false)} className="text-white/40 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between"><span className="text-white/40">Bandwidth</span><span className="text-emerald-400">{stats.bandwidth} kbps</span></div>
              <div className="flex justify-between"><span className="text-white/40">Buffer</span><span className="text-blue-400">{stats.bufferLen.toFixed(1)}s</span></div>
              <div className="flex justify-between"><span className="text-white/40">Quality</span><span className="text-white">{stats.levelName}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Download</span><span className="text-white/70">{stats.downloadTime}ms</span></div>
              <div className="flex justify-between"><span className="text-white/40">Segments</span><span className="text-white/70">{stats.segmentsLoaded}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Dropped</span><span className={stats.droppedFrames > 0 ? 'text-amber-400' : 'text-white/70'}>{stats.droppedFrames}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Rebuffers</span><span className={stats.rebufferCount > 0 ? 'text-red-400' : 'text-white/70'}>{stats.rebufferCount}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Speed</span><span className="text-white/70">{playbackRate}x</span></div>

              {stats.bitrateHistory.length > 0 && (
                <div className="pt-2 border-t border-white/10">
                  <span className="text-white/30 text-[9px] uppercase tracking-widest">Switch History</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {stats.bitrateHistory.slice(-8).map((h, i) => (
                      <span key={i} className="px-1.5 py-0.5 bg-white/5 rounded text-[9px]">{h.level}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls Overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 z-20 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex flex-col gap-3">
          {/* Seek Bar with buffer visualization */}
          <div
            className="relative w-full h-2 flex items-center cursor-pointer group/seek"
            onClick={handleSeek}
            onMouseMove={handleSeekHover}
            onMouseLeave={() => setHoverTime(null)}
          >
            {/* Background track */}
            <div className="absolute w-full h-1 bg-white/20 rounded-full group-hover/seek:h-1.5 transition-all" />

            {/* Buffered ranges */}
            {bufferedRanges.map((range, i) => (
              <div
                key={i}
                className="absolute h-1 bg-white/30 rounded-full group-hover/seek:h-1.5 transition-all"
                style={{ left: `${range.start}%`, width: `${range.end - range.start}%` }}
              />
            ))}

            {/* Progress */}
            <div
              className="absolute h-1 bg-emerald-500 rounded-full group-hover/seek:h-1.5 transition-all"
              style={{ width: `${progress}%` }}
            />

            {/* Seek head */}
            <div
              className="absolute w-3 h-3 bg-emerald-500 rounded-full -translate-x-1/2 opacity-0 group-hover/seek:opacity-100 transition-opacity shadow-lg"
              style={{ left: `${progress}%` }}
            />

            {/* Hover time tooltip */}
            {hoverTime !== null && (
              <div
                className="absolute -top-8 bg-black/90 text-white text-[10px] font-mono px-2 py-1 rounded -translate-x-1/2"
                style={{ left: `${hoverX}px` }}
              >
                {formatTime(hoverTime)}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-white">
            <div className="flex items-center gap-3">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="hover:text-emerald-400 transition-colors" id="player-play-btn">
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group/volume">
                <button onClick={toggleMute} className="hover:text-emerald-400 transition-colors">
                  {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-0 group-hover/volume:w-20 transition-all appearance-none bg-white/20 h-1 rounded-full accent-emerald-500 cursor-pointer"
                />
              </div>

              {/* Time */}
              <div className="text-xs font-mono opacity-70 flex items-center gap-1.5">
                <span>{formatTime(videoRef.current?.currentTime || 0)}</span>
                <span className="opacity-40">/</span>
                <span>{formatTime(videoRef.current?.duration || 0)}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Live stats chip */}
              <div className="hidden sm:flex items-center gap-2 px-2 py-1 bg-white/10 rounded text-[10px] font-mono">
                <Activity size={10} className="text-emerald-500" />
                <span>{Math.round(stats.bandwidth)} kbps</span>
                <span className="opacity-30">|</span>
                <span>BUF {stats.bufferLen.toFixed(1)}s</span>
                <span className="opacity-30">|</span>
                <span className="text-emerald-400">{stats.levelName}</span>
              </div>

              {/* Analytics toggle */}
              <button
                onClick={() => setShowAnalytics(!showAnalytics)}
                className={`hover:text-emerald-400 transition-colors ${showAnalytics ? 'text-emerald-400' : ''}`}
                title="Stream Analytics"
              >
                <BarChart3 size={18} />
              </button>

              {/* Speed */}
              <div className="relative group/speed">
                <button className="hover:text-emerald-400 transition-colors text-xs font-mono font-bold px-1">
                  {playbackRate}x
                </button>
                <div className="absolute bottom-full right-0 mb-2 w-24 bg-black/90 backdrop-blur-xl border border-white/10 rounded-xl p-1.5 shadow-2xl hidden group-hover/speed:block">
                  <div className="text-[9px] font-mono text-white/40 px-2 py-0.5 uppercase tracking-widest">Speed</div>
                  {speeds.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-white/10 ${playbackRate === s ? 'text-emerald-400' : ''}`}
                    >
                      <span>{s}x</span>
                      {playbackRate === s && <Check size={10} />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality Settings */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className={`hover:text-emerald-400 transition-colors ${showSettings ? 'text-emerald-400' : ''}`}
                >
                  <Settings size={18} />
                </button>

                <AnimatePresence>
                  {showSettings && (
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      className="absolute bottom-full right-0 mb-3 w-44 bg-black/90 backdrop-blur-xl border border-white/10 rounded-xl p-2 shadow-2xl"
                    >
                      <div className="text-[10px] font-mono text-white/40 px-2 py-1 uppercase tracking-widest">Quality</div>
                      <button
                        onClick={() => selectLevel(-1)}
                        className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs hover:bg-white/10 transition-colors ${currentLevel === -1 ? 'text-emerald-400' : ''}`}
                      >
                        <span>Auto</span>
                        {currentLevel === -1 && <Check size={12} />}
                      </button>
                      {levels.map((level) => (
                        <button
                          key={level.id}
                          onClick={() => selectLevel(level.id)}
                          className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs hover:bg-white/10 transition-colors ${currentLevel === level.id ? 'text-emerald-400' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <span>{level.height}p</span>
                            <span className="text-[9px] text-white/30">{Math.round(level.bitrate / 1000)}k</span>
                          </div>
                          {currentLevel === level.id && <Check size={12} />}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* PiP */}
              <button
                onClick={togglePiP}
                className={`hover:text-emerald-400 transition-colors ${isPiP ? 'text-emerald-400' : ''}`}
                title="Picture in Picture"
              >
                <PictureInPicture2 size={18} />
              </button>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="hover:text-emerald-400 transition-colors"
                title="Fullscreen (F)"
              >
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
