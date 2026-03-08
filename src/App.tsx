import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Play, Upload, Database, Activity, Cpu, Layers, Server, Shield,
  ChevronRight, Clock, Video, Link as LinkIcon, Trash2, Search,
  X, CheckCircle2, AlertCircle, Info
} from 'lucide-react';
import { Player } from './components/Player.tsx';
import { Uploader } from './components/Uploader.tsx';

interface StreamInfo {
  resolution: string;
  width: number;
  height: number;
  bitrate: number;
  playlist_path: string;
}

interface VideoMetadata {
  id: string;
  title: string;
  status: string;
  status_detail?: string;
  progress?: number;
  created_at: string;
  duration?: number;
  codec?: string;
  file_size?: number;
  thumbnail_path?: string;
  source_type?: string;
  filename?: string;
  streams?: StreamInfo[];
  resolutions?: string[];
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

const API_BASE = import.meta.env.VITE_API_URL || '';

export default function App() {
  const [videos, setVideos] = useState<VideoMetadata[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<VideoMetadata | null>(null);
  const [showUploader, setShowUploader] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);

  // ── Responsive ───────────────────────────────────────────────────
  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) setShowSidebar(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ── Toast helper ─────────────────────────────────────────────────
  const addToast = (type: Toast['type'], message: string) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  // ── Fetch videos ─────────────────────────────────────────────────
  const fetchVideos = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/videos`);
      const data = await response.json();
      setVideos(data);

      if (selectedVideo) {
        const updated = data.find((v: VideoMetadata) => v.id === selectedVideo.id);
        if (updated && (updated.status !== selectedVideo.status || updated.progress !== selectedVideo.progress)) {
          setSelectedVideo(updated);
        }
      }
      setLoading(false);
    } catch {
      // Silently fail on poll
    }
  };

  useEffect(() => {
    fetchVideos();
    const interval = setInterval(fetchVideos, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── Delete video ─────────────────────────────────────────────────
  const handleDelete = async (videoId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/videos/${videoId}`, { method: 'DELETE' });
      if (res.ok) {
        if (selectedVideo?.id === videoId) setSelectedVideo(null);
        setDeleteConfirm(null);
        addToast('success', 'Video deleted successfully');
        fetchVideos();
      } else {
        addToast('error', 'Failed to delete video');
      }
    } catch {
      addToast('error', 'Network error deleting video');
    }
  };

  // ── Filtered videos ──────────────────────────────────────────────
  const filteredVideos = useMemo(() => {
    return videos.filter(v => {
      const matchesSearch = !searchQuery ||
        v.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.id.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || v.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [videos, searchQuery, statusFilter]);

  // ── Format helpers ───────────────────────────────────────────────
  const formatDuration = (seconds: number | null | undefined) => {
    if (!seconds) return '--:--';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatBytes = (bytes: number | null | undefined) => {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const getManifestPath = (video: VideoMetadata) => {
    // Remote URLs: route through our proxy-stream endpoint
    // This avoids CORS blocks and enables chunked streaming with seeking
    if (video.source_type === 'url') {
      return `${API_BASE}/api/proxy-stream/${video.id}`;
    }
    // For uploaded files: check if HLS streams exist, otherwise play raw upload
    if (video.streams && video.streams.length > 0) {
      return `${API_BASE}/streams/${video.id}/master.m3u8`;
    }
    // Fallback: serve the raw uploaded file directly
    if (video.filename) {
      return `${API_BASE}/uploads/${video.filename}`;
    }
    return `${API_BASE}/streams/${video.id}/master.m3u8`;
  };

  const getThumbnailUrl = (path: string | null) => {
    if (!path) return undefined;
    if (path.startsWith('http')) return path;
    return `${API_BASE}${path}`;
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-emerald-500/30">
      {/* Navigation Rail */}
      <nav className="fixed left-0 top-0 bottom-0 w-16 border-r border-white/5 bg-black/40 backdrop-blur-xl flex flex-col items-center py-8 gap-8 z-50">
        <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-600/20">
          <Video size={24} className="text-white" />
        </div>
        <div className="flex flex-col gap-6 opacity-40">
          <div className="relative group">
            <Activity size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
            <span className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              Pipeline Active
            </span>
          </div>
          <div className="relative group">
            <Database size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
            <span className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              SQLite + Redis
            </span>
          </div>
          <div className="relative group">
            <Cpu size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
            <span className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              FFmpeg Workers
            </span>
          </div>
          <Layers size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
          <Server size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
          <Shield size={20} className="hover:text-emerald-400 cursor-pointer transition-colors" />
        </div>
      </nav>

      {/* Main Content */}
      <main className="pl-16 min-h-screen">
        {/* Header */}
        <header className="p-8 lg:p-12 border-b border-white/5">
          <div className="max-w-7xl mx-auto flex flex-col lg:flex-row justify-between items-start lg:items-end gap-6">
            <div>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-3 mb-4"
              >
                <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-500 text-[10px] font-mono tracking-widest uppercase">
                  Production v2.0
                </span>
                <span className="w-1 h-1 rounded-full bg-white/20" />
                <span className="text-white/40 text-[10px] font-mono tracking-widest uppercase">
                  Adaptive Streaming Platform
                </span>
              </motion.div>
              <h1 className="text-5xl lg:text-7xl font-bold tracking-tighter leading-none mb-4">
                Eye<span className="text-emerald-500">con</span>
              </h1>
              <p className="text-white/50 max-w-xl text-sm lg:text-lg leading-relaxed">
                Production-grade OTT streaming. 6-variant ABR encoding, BullMQ pipeline,
                signed URL security, and real-time analytics.
              </p>
            </div>

            <div className="flex gap-3">
              {isMobile && !showUploader && videos.length > 0 && (
                <button
                  onClick={() => setShowSidebar(!showSidebar)}
                  className="px-4 py-3 bg-white/10 text-white rounded-full font-medium text-sm hover:bg-white/20 transition-all"
                >
                  Library
                </button>
              )}
              <button
                onClick={() => setShowUploader(!showUploader)}
                className="flex items-center gap-3 px-6 lg:px-8 py-3 lg:py-4 bg-white text-black rounded-full font-semibold hover:bg-emerald-400 transition-all active:scale-95 text-sm lg:text-base"
              >
                {showUploader ? <ChevronRight size={20} /> : <Upload size={20} />}
                {showUploader ? 'Back to Library' : 'Add Media'}
              </button>
            </div>
          </div>
        </header>

        <div className="max-w-7xl mx-auto p-6 lg:p-12">
          <AnimatePresence mode="wait">
            {showUploader || videos.length === 0 ? (
              <motion.div
                key="uploader"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="max-w-3xl mx-auto"
              >
                <Uploader onUploadComplete={() => {
                  setShowUploader(false);
                  addToast('success', 'Video submitted for transcoding');
                  fetchVideos();
                }} />
              </motion.div>
            ) : (
              <motion.div
                key="library"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="grid grid-cols-12 gap-6 lg:gap-12"
              >
                {/* Player Section */}
                <div className={`${isMobile ? 'col-span-12' : 'col-span-8'}`}>
                  {selectedVideo ? (
                    <div className="space-y-6">
                      {selectedVideo.status === 'completed' ? (
                        <Player
                          src={getManifestPath(selectedVideo)}
                          title={selectedVideo.title}
                        />
                      ) : (
                        <div className="aspect-video bg-white/5 rounded-2xl border border-white/10 flex flex-col items-center justify-center text-center p-12 gap-6 relative overflow-hidden">
                          <div className={`absolute inset-0 opacity-10 blur-[100px] ${selectedVideo.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500'}`} />
                          <div className="relative z-10 flex flex-col items-center gap-4">
                            <div className={`w-20 h-20 rounded-full border-2 flex items-center justify-center ${selectedVideo.status === 'failed' ? 'border-red-500/50 text-red-500' : 'border-emerald-500/50 text-emerald-500'}`}>
                              {selectedVideo.status === 'processing' ? (
                                <Activity size={40} className="animate-pulse" />
                              ) : selectedVideo.status === 'failed' ? (
                                <Shield size={40} />
                              ) : (
                                <Clock size={40} />
                              )}
                            </div>
                            <div className="space-y-2">
                              <h2 className="text-2xl font-bold tracking-tight">{selectedVideo.title}</h2>
                              <p className={`text-sm font-mono uppercase tracking-widest ${selectedVideo.status === 'failed' ? 'text-red-500' : 'text-emerald-500'}`}>
                                {selectedVideo.status === 'processing' ? `Processing: ${Math.round(selectedVideo.progress || 0)}%` : selectedVideo.status}
                              </p>
                              {selectedVideo.status_detail && (
                                <p className="text-white/40 text-xs italic max-w-md mx-auto">{selectedVideo.status_detail}</p>
                              )}
                            </div>
                            {selectedVideo.status === 'processing' && (
                              <div className="w-64 h-1.5 bg-white/10 rounded-full overflow-hidden mt-4">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: `${selectedVideo.progress || 0}%` }}
                                  className="h-full bg-emerald-500 rounded-full"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Video Info Panel */}
                      <div className="flex items-center justify-between p-5 bg-white/5 rounded-2xl border border-white/10">
                        <div className="flex items-center gap-4">
                          {selectedVideo.thumbnail_path && (
                            <img
                              src={selectedVideo.thumbnail_path}
                              alt=""
                              className="w-16 h-10 rounded-lg object-cover hidden sm:block"
                            />
                          )}
                          <div>
                            <h2 className="text-lg font-bold mb-1">{selectedVideo.title}</h2>
                            <div className="flex items-center gap-3 flex-wrap text-white/40 text-xs font-mono">
                              <span className="flex items-center gap-1">
                                <Clock size={12} />
                                {formatDuration(selectedVideo.duration)}
                              </span>
                              {selectedVideo.codec && (
                                <span className="px-1.5 py-0.5 bg-white/10 rounded text-[10px]">{selectedVideo.codec.toUpperCase()}</span>
                              )}
                              {selectedVideo.file_size && (
                                <span>{formatBytes(selectedVideo.file_size)}</span>
                              )}
                              <span className="flex items-center gap-1">
                                <Clock size={12} />
                                {new Date(selectedVideo.created_at).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedVideo.status === 'completed' && selectedVideo.resolutions && (
                            <div className="hidden sm:flex gap-1">
                              {selectedVideo.resolutions.map(r => (
                                <span key={r} className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[9px] font-mono font-bold">{r}</span>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => setDeleteConfirm(selectedVideo.id)}
                            className="p-2 text-white/20 hover:text-red-400 transition-colors"
                            title="Delete video"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="aspect-video bg-white/5 rounded-2xl border border-white/10 border-dashed flex flex-col items-center justify-center text-white/20 gap-4">
                      <div className="w-20 h-20 rounded-full border-2 border-current flex items-center justify-center opacity-20">
                        <Play size={40} />
                      </div>
                      <p className="font-mono tracking-widest uppercase text-xs">Select a video to begin streaming</p>
                    </div>
                  )}
                </div>

                {/* Library Sidebar */}
                {(showSidebar || !isMobile) && (
                  <div className={`${isMobile ? 'col-span-12' : 'col-span-4'} space-y-4`}>
                    {/* Search + Filter */}
                    <div className="space-y-3">
                      <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search videos..."
                          className="w-full bg-white/5 border border-white/5 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white/60 focus:outline-none focus:border-white/20 transition-all placeholder:text-white/15"
                        />
                      </div>
                      <div className="flex gap-1.5">
                        {['all', 'completed', 'processing', 'pending', 'failed'].map(s => (
                          <button
                            key={s}
                            onClick={() => setStatusFilter(s)}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-colors ${
                              statusFilter === s
                                ? 'bg-emerald-500/20 text-emerald-500'
                                : 'bg-white/5 text-white/30 hover:bg-white/10'
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-mono tracking-widest uppercase text-white/40">Media Library</h3>
                      <span className="text-[10px] font-mono text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded">
                        {filteredVideos.length} ASSETS
                      </span>
                    </div>

                    {/* Video List */}
                    <div className="space-y-2 max-h-[calc(100vh-400px)] overflow-y-auto pr-1 scrollbar-thin">
                      {filteredVideos.map((video) => (
                        <motion.div
                          key={video.id}
                          whileHover={{ x: 4 }}
                          onClick={() => {
                            setSelectedVideo(video);
                            if (isMobile) setShowSidebar(false);
                          }}
                          className={`relative p-3 rounded-xl border transition-all cursor-pointer group overflow-hidden ${
                            selectedVideo?.id === video.id
                              ? 'bg-white/10 border-white/20'
                              : 'bg-white/[0.03] border-white/5 hover:bg-white/10 hover:border-white/10'
                          }`}
                        >
                          {video.status === 'processing' && (
                            <div
                              className="absolute bottom-0 left-0 h-0.5 bg-emerald-500/40 transition-all duration-500"
                              style={{ width: `${video.progress || 0}%` }}
                            />
                          )}

                          <div className="flex gap-3">
                            {/* Thumbnail */}
                            <div className="w-20 h-12 rounded-lg bg-white/5 overflow-hidden flex-shrink-0">
                              {video.thumbnail_path ? (
                                <img src={getThumbnailUrl(video.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Video size={16} className="text-white/10" />
                                </div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="font-medium truncate text-sm pr-2">{video.title}</h4>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  {video.status === 'processing' ? (
                                    <Activity size={12} className="text-emerald-500 animate-pulse" />
                                  ) : video.status === 'completed' ? (
                                    <Play size={12} className="text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  ) : video.status === 'failed' ? (
                                    <Shield size={12} className="text-red-500" />
                                  ) : (
                                    <Clock size={12} className="text-white/20" />
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setDeleteConfirm(video.id); }}
                                    className="text-white/0 group-hover:text-white/20 hover:!text-red-400 transition-colors p-0.5"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 text-[10px] font-mono">
                                <span className="text-white/20">{formatDuration(video.duration)}</span>
                                <span className={`uppercase tracking-tight font-bold ${
                                  video.status === 'completed' ? 'text-emerald-500' :
                                  video.status === 'failed' ? 'text-red-500' : 'text-amber-500'
                                }`}>
                                  {video.status === 'processing'
                                    ? `${Math.round(video.progress || 0)}%`
                                    : video.status}
                                </span>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      ))}

                      {filteredVideos.length === 0 && !loading && (
                        <div className="p-8 text-center border border-white/5 rounded-xl border-dashed">
                          <p className="text-white/20 text-sm font-mono">
                            {searchQuery || statusFilter !== 'all' ? 'No matching videos' : 'No assets found'}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
            onClick={() => setDeleteConfirm(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#111] border border-white/10 rounded-2xl p-8 max-w-sm w-full shadow-2xl"
            >
              <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <Trash2 size={24} className="text-red-500" />
                </div>
                <h3 className="text-xl font-bold mb-2">Delete Video</h3>
                <p className="text-white/40 text-sm">
                  This will permanently delete the video, all encoded segments, and the thumbnail. This action cannot be undone.
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 py-3 bg-white/10 hover:bg-white/20 rounded-xl font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm)}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-500 rounded-xl font-medium transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-[100] space-y-2">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className={`flex items-center gap-3 px-5 py-3 rounded-xl border shadow-2xl backdrop-blur-xl ${
                toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                toast.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                'bg-blue-500/10 border-blue-500/20 text-blue-400'
              }`}
            >
              {toast.type === 'success' ? <CheckCircle2 size={16} /> :
               toast.type === 'error' ? <AlertCircle size={16} /> :
               <Info size={16} />}
              <span className="text-sm font-medium">{toast.message}</span>
              <button onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}>
                <X size={14} className="opacity-40 hover:opacity-100" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none z-[-1] overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-900/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
      </div>
    </div>
  );
}
