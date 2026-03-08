import React, { useState, useRef, useCallback } from 'react';
import {
  Upload, Play, Loader2, Link as LinkIcon, Globe, Activity,
  Shield, FileVideo, X, CheckCircle2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface UploaderProps {
  onUploadComplete: () => void;
}

type Tab = 'upload' | 'url';

const API_BASE = import.meta.env.VITE_API_URL || '';

export const Uploader: React.FC<UploaderProps> = ({ onUploadComplete }) => {
  const [activeTab, setActiveTab] = useState<Tab>('upload');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File validation ──────────────────────────────────────────────
  const validateFile = (file: File): string | null => {
    const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
    const allowedTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'video/avi'];

    if (!allowedTypes.includes(file.type) && !file.name.match(/\.(mp4|webm|ogg|mov|mkv|avi)$/i)) {
      return 'Unsupported format. Use MP4, WebM, OGG, MOV, MKV, or AVI.';
    }
    if (file.size > maxSize) {
      return `File too large (${formatSize(file.size)}). Maximum: 5 GB.`;
    }
    return null;
  };

  // ── URL validation ───────────────────────────────────────────────
  const validateUrl = (inputUrl: string): boolean => {
    if (!inputUrl) return false;
    try {
      const parsed = new URL(inputUrl);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  // ── Drag handlers ────────────────────────────────────────────────
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const file = e.dataTransfer.files?.[0];
    if (file) selectFile(file);
  }, []);

  const selectFile = (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSelectedFile(file);
    setError(null);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
  };

  // ── File upload with progress ────────────────────────────────────
  const handleUpload = async () => {
    if (!selectedFile) return;
    setError(null);
    setUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('title', title || selectedFile.name);

    const xhr = new XMLHttpRequest();
    const startTime = Date.now();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = (e.loaded / e.total) * 100;
        setUploadProgress(percent);

        const elapsed = (Date.now() - startTime) / 1000;
        const speed = e.loaded / elapsed;
        setUploadSpeed(formatSpeed(speed));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setSelectedFile(null);
        setTitle('');
        setUploadProgress(100);
        setTimeout(() => {
          setUploading(false);
          onUploadComplete();
        }, 500);
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          setError(data.error || `Upload failed (Status ${xhr.status})`);
        } catch {
          setError(`Upload failed. Server returned status ${xhr.status}.`);
        }
        setUploading(false);
      }
    });

    xhr.addEventListener('error', () => {
      setError('Network error. Please check your connection.');
      setUploading(false);
    });

    xhr.open('POST', `${API_BASE}/api/upload`);
    xhr.send(formData);
  };

  // ── URL stream ───────────────────────────────────────────────────
  const handleStream = async () => {
    setError(null);
    if (!url) return;

    if (!validateUrl(url)) {
      setError('Invalid URL. Please provide a valid HTTP/HTTPS link to a video or stream.');
      return;
    }

    setUploading(true);
    try {
      const response = await fetch(`${API_BASE}/api/ingest-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: title || 'Remote Stream' }),
      });

      if (response.ok) {
        setUrl('');
        setTitle('');
        onUploadComplete();
      } else {
        let errorMessage = `Failed to ingest video (Status ${response.status}).`;
        try {
          const data = await response.json();
          if (data.error) errorMessage = data.error;
        } catch {
          // If response is not JSON (e.g., 404 HTML page or 502 Bad Gateway)
        }
        setError(errorMessage);
      }
    } catch (err: any) {
      setError(`Network error: ${err.message || 'Please check your connection.'}`);
    } finally {
      setUploading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-3xl p-10 backdrop-blur-md shadow-2xl">
      <div className="text-center mb-8">
        <h2 className="text-4xl font-bold tracking-tighter mb-3 bg-gradient-to-r from-white to-white/40 bg-clip-text text-transparent">
          Add Media
        </h2>
        <p className="text-white/40 font-mono text-xs tracking-widest uppercase">
          Upload a video file or stream from a remote URL
        </p>
      </div>

      {/* Tab Switcher */}
      <div className="flex bg-white/5 rounded-xl p-1 mb-8">
        <button
          onClick={() => { setActiveTab('upload'); setError(null); }}
          className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'upload'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'text-white/40 hover:text-white/60'
          }`}
        >
          <Upload size={16} />
          Upload File
        </button>
        <button
          onClick={() => { setActiveTab('url'); setError(null); }}
          className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'url'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'text-white/40 hover:text-white/60'
          }`}
        >
          <LinkIcon size={16} />
          Stream URL
        </button>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'upload' ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* Drag Zone */}
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
                dragActive
                  ? 'border-emerald-500 bg-emerald-500/10 scale-[1.02]'
                  : selectedFile
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-white/10 hover:border-white/20 hover:bg-white/5'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) selectFile(file);
                }}
              />

              {selectedFile ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center">
                    <FileVideo size={32} className="text-emerald-500" />
                  </div>
                  <div>
                    <p className="text-white font-medium truncate max-w-md">{selectedFile.name}</p>
                    <p className="text-white/40 text-sm">{formatSize(selectedFile.size)}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedFile(null); setTitle(''); }}
                    className="text-white/30 hover:text-red-400 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center">
                    <Upload size={32} className="text-white/20" />
                  </div>
                  <div>
                    <p className="text-white/60 text-sm">Drag and drop a video file here</p>
                    <p className="text-white/20 text-xs mt-1">or click to browse • MP4, WebM, MOV, MKV • Max 5 GB</p>
                  </div>
                </div>
              )}
            </div>

            {/* Upload Progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-white/40">
                  <span>Uploading... {uploadSpeed}</span>
                  <span>{Math.round(uploadProgress)}%</span>
                </div>
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-emerald-500 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>
            )}

            {/* Title + Upload button */}
            <div className="flex gap-3">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Video title (optional)"
                className="flex-1 bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-white/60 text-sm focus:outline-none focus:border-white/20 transition-all"
              />
              <button
                onClick={handleUpload}
                disabled={!selectedFile || uploading}
                className="px-8 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/5 disabled:text-white/20 text-white font-bold rounded-xl transition-all flex items-center gap-2 active:scale-95"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                Upload
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="url"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* URL Input */}
            <div className="relative group">
              <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none text-white/20 group-focus-within:text-emerald-500 transition-colors">
                <LinkIcon size={20} />
              </div>
              <input
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); if (error) setError(null); }}
                placeholder="https://example.com/video.mp4"
                className={`w-full bg-black/60 border rounded-2xl pl-14 pr-32 py-5 text-white text-lg focus:outline-none focus:ring-4 transition-all placeholder:text-white/10 ${
                  error ? 'border-red-500/50 focus:border-red-500 focus:ring-red-500/10' : 'border-white/10 focus:border-emerald-500/50 focus:ring-emerald-500/10'
                }`}
              />
              <button
                onClick={handleStream}
                disabled={uploading || !url}
                className="absolute right-3 top-3 bottom-3 px-8 bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/5 disabled:text-white/20 text-white font-bold rounded-xl transition-all flex items-center gap-2 active:scale-95"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
                Stream
              </button>
            </div>

            {/* Title */}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Video title (optional)"
              className="w-full bg-white/5 border border-white/5 rounded-xl px-5 py-3 text-white/60 text-sm focus:outline-none focus:border-white/20 transition-all"
            />

            {/* Format chips */}
            <div className="flex flex-wrap gap-2 justify-center">
              {['MP4', 'WEBM', 'OGG', 'MOV', 'HLS', 'DASH'].map((type) => (
                <span key={type} className="px-3 py-1 bg-white/5 border border-white/5 rounded text-[10px] font-mono text-white/30 tracking-widest">
                  {type}
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error display */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-4 px-5 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-xs font-mono flex items-center gap-2"
          >
            <Shield size={14} />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <div className="mt-8 pt-8 border-t border-white/5 flex items-center justify-center gap-8 text-white/20">
        <div className="flex items-center gap-2">
          <Globe size={14} />
          <span className="text-[10px] font-mono tracking-widest uppercase">CDN Ready</span>
        </div>
        <div className="flex items-center gap-2">
          <Activity size={14} />
          <span className="text-[10px] font-mono tracking-widest uppercase">Auto-ABR</span>
        </div>
        <div className="flex items-center gap-2">
          <Shield size={14} />
          <span className="text-[10px] font-mono tracking-widest uppercase">Signed URLs</span>
        </div>
      </div>
    </div>
  );
};
