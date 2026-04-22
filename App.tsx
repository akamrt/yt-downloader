import React, { useState, useRef, useCallback, useEffect } from 'react';

// ---- Types ----

type Quality = 'best' | '1080p' | '720p' | '480p' | '360p' | 'mp3';
type Format = 'mp4' | 'webm' | 'mp3';
type DownloadStatus = 'queued' | 'starting' | 'downloading' | 'processing' | 'complete' | 'error';

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  uploader: string;
  view_count: number;
  description: string;
  is_playlist: boolean;
  playlist_count: number | null;
  webpage_url: string;
}

interface DownloadItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  quality: Quality;
  format: Format;
  status: DownloadStatus;
  progress: number;
  speed: string | null;
  eta: string | null;
  filepath: string | null;
  error: string | null;
  startedAt: number;
}

// ---- Constants ----

const DOWNLOAD_SERVER = 'http://127.0.0.1:3002';

const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: 'best', label: 'Best Quality' },
  { value: '1080p', label: '1080p HD' },
  { value: '720p', label: '720p HD' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
  { value: 'mp3', label: 'Audio Only (MP3)' },
];

const FORMAT_OPTIONS: { value: Format; label: string }[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mp3', label: 'MP3' },
];

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViews(n: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K views`;
  return `${n} views`;
}

// ---- Main App ----

export default function App() {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState<Quality>('best');
  const [format, setFormat] = useState<Format>('mp4');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [serverReady, setServerReady] = useState(false);

  // Check download server health
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${DOWNLOAD_SERVER}/api/health`);
        if (res.ok && !cancelled) setServerReady(true);
      } catch {
        if (!cancelled) setTimeout(check, 2000);
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  const updateDownload = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, ...patch } : d));
  }, []);

  const handleGetInfo = useCallback(async () => {
    if (!url.trim()) return;
    setInfoLoading(true);
    setInfoError(null);
    setVideoInfo(null);

    try {
      const res = await fetch(`${DOWNLOAD_SERVER}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      const info = await res.json();
      setVideoInfo(info);
    } catch (e: any) {
      setInfoError(e.message || 'Failed to fetch video info');
    } finally {
      setInfoLoading(false);
    }
  }, [url]);

  const startDownload = useCallback(async (overrideUrl?: string) => {
    const targetUrl = overrideUrl || url.trim();
    if (!targetUrl) return;

    // Use info title/thumbnail if available
    const title = videoInfo?.title || 'Downloading...';
    const thumbnail = videoInfo?.thumbnail || '';

    try {
      const res = await fetch(`${DOWNLOAD_SERVER}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, quality, format }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const { id } = await res.json();

      const item: DownloadItem = {
        id,
        url: targetUrl,
        title,
        thumbnail,
        quality,
        format,
        status: 'starting',
        progress: 0,
        speed: null,
        eta: null,
        filepath: null,
        error: null,
        startedAt: Date.now(),
      };
      setDownloads(prev => [item, ...prev]);

      // SSE progress
      const es = new EventSource(`${DOWNLOAD_SERVER}/progress/${id}`);
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          updateDownload(id, {
            status: data.status || 'downloading',
            progress: data.progress ?? undefined,
            speed: data.speed || null,
            eta: data.eta || null,
            filepath: data.filepath || null,
            error: data.message && data.status === 'error' ? data.message : null,
          });
          if (data.status === 'complete' || data.status === 'error') {
            es.close();
          }
        } catch {}
      };
      es.onerror = () => es.close();

    } catch (e: any) {
      console.error('Download failed to start:', e);
    }
  }, [url, quality, format, videoInfo, updateDownload]);

  const handleDownloadAll = useCallback(async () => {
    if (!videoInfo?.is_playlist || !url.trim()) return;
    // For playlists, pass the playlist URL directly with playlist flag
    await startDownload(url.trim());
  }, [videoInfo, url, startDownload]);

  const openFolder = useCallback((filepath: string) => {
    // Electron shell or fallback
    const dir = filepath.includes('/') || filepath.includes('\\')
      ? filepath.substring(0, Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\')))
      : filepath;
    // Try Electron IPC if available
    if ((window as any).electronAPI?.openPath) {
      (window as any).electronAPI.openPath(dir);
    } else {
      alert(`File saved to: ${filepath}`);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleGetInfo();
  }, [handleGetInfo]);

  // Auto-detect format when quality is mp3
  useEffect(() => {
    if (quality === 'mp3') setFormat('mp3');
    else if (format === 'mp3') setFormat('mp4');
  }, [quality]);

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>⬇</span>
            <span style={styles.logoText}>YT Downloader</span>
          </div>
          <div style={styles.serverBadge}>
            <span style={{ ...styles.statusDot, background: serverReady ? '#22c55e' : '#f59e0b' }} />
            <span style={styles.serverLabel}>{serverReady ? 'Ready' : 'Connecting...'}</span>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* URL Input Card */}
        <div style={styles.card}>
          <div style={styles.urlRow}>
            <input
              style={styles.urlInput}
              type="text"
              placeholder="Paste YouTube URL here..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
            <button
              style={{ ...styles.btn, ...(infoLoading ? styles.btnDisabled : {}) }}
              onClick={handleGetInfo}
              disabled={infoLoading || !url.trim()}
            >
              {infoLoading ? 'Loading...' : 'Get Info'}
            </button>
          </div>

          {infoError && (
            <div style={styles.errorBanner}>
              <span style={styles.errorIcon}>⚠</span> {infoError}
            </div>
          )}
        </div>

        {/* Video Info Preview */}
        {videoInfo && (
          <div style={styles.card}>
            <div style={styles.infoRow}>
              {videoInfo.thumbnail && (
                <img src={videoInfo.thumbnail} alt="thumbnail" style={styles.thumb} />
              )}
              <div style={styles.infoMeta}>
                <div style={styles.infoTitle}>{videoInfo.title}</div>
                <div style={styles.infoSub}>
                  {videoInfo.uploader && <span>{videoInfo.uploader}</span>}
                  {videoInfo.duration > 0 && <span> · {formatDuration(videoInfo.duration)}</span>}
                  {videoInfo.view_count > 0 && <span> · {formatViews(videoInfo.view_count)}</span>}
                </div>
                {videoInfo.is_playlist && (
                  <div style={styles.playlistBadge}>
                    📋 Playlist · {videoInfo.playlist_count ?? '?'} videos
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div style={styles.controlsRow}>
              <div style={styles.controlGroup}>
                <label style={styles.label}>Quality</label>
                <select
                  style={styles.select}
                  value={quality}
                  onChange={e => setQuality(e.target.value as Quality)}
                >
                  {QUALITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div style={styles.controlGroup}>
                <label style={styles.label}>Format</label>
                <select
                  style={styles.select}
                  value={format}
                  onChange={e => setFormat(e.target.value as Format)}
                  disabled={quality === 'mp3'}
                >
                  {FORMAT_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div style={styles.downloadBtnGroup}>
                <button
                  style={{ ...styles.btn, ...styles.btnPrimary, ...((!serverReady) ? styles.btnDisabled : {}) }}
                  onClick={() => startDownload()}
                  disabled={!serverReady}
                >
                  ⬇ {videoInfo.is_playlist ? 'Download First' : 'Download'}
                </button>
                {videoInfo.is_playlist && (
                  <button
                    style={{ ...styles.btn, ...styles.btnSecondary, ...((!serverReady) ? styles.btnDisabled : {}) }}
                    onClick={handleDownloadAll}
                    disabled={!serverReady}
                  >
                    ⬇ Download All ({videoInfo.playlist_count ?? '?'})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Download Queue */}
        {downloads.length > 0 && (
          <div style={styles.card}>
            <h2 style={styles.sectionTitle}>Downloads</h2>
            <div style={styles.queue}>
              {downloads.map(dl => (
                <DownloadRow key={dl.id} item={dl} onOpenFolder={openFolder} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {downloads.length === 0 && !videoInfo && !infoLoading && (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>📥</div>
            <div style={styles.emptyText}>Paste a YouTube URL above to get started</div>
            <div style={styles.emptyHint}>Supports videos, playlists, Shorts — downloads to ~/Downloads</div>
          </div>
        )}
      </main>
    </div>
  );
}

// ---- DownloadRow Component ----

function DownloadRow({ item, onOpenFolder }: { item: DownloadItem; onOpenFolder: (path: string) => void }) {
  const statusColor: Record<DownloadStatus, string> = {
    queued: '#6b7280',
    starting: '#f59e0b',
    downloading: '#3b82f6',
    processing: '#8b5cf6',
    complete: '#22c55e',
    error: '#ef4444',
  };

  const statusLabel: Record<DownloadStatus, string> = {
    queued: 'Queued',
    starting: 'Starting...',
    downloading: 'Downloading',
    processing: 'Processing',
    complete: 'Complete',
    error: 'Error',
  };

  return (
    <div style={styles.queueItem}>
      {item.thumbnail && (
        <img src={item.thumbnail} alt="" style={styles.queueThumb} />
      )}
      <div style={styles.queueInfo}>
        <div style={styles.queueTitle}>{item.title}</div>
        <div style={styles.queueMeta}>
          <span style={{ ...styles.statusChip, background: statusColor[item.status] + '22', color: statusColor[item.status] }}>
            {statusLabel[item.status]}
          </span>
          <span style={styles.queueMetaText}>{item.quality} · {item.format.toUpperCase()}</span>
          {item.speed && <span style={styles.queueMetaText}>{item.speed}</span>}
          {item.eta && <span style={styles.queueMetaText}>ETA {item.eta}</span>}
        </div>

        {(item.status === 'downloading' || item.status === 'processing') && (
          <div style={styles.progressTrack}>
            <div
              style={{
                ...styles.progressBar,
                width: `${Math.min(item.progress, 100)}%`,
                background: statusColor[item.status],
              }}
            />
            <span style={styles.progressLabel}>{item.progress.toFixed(0)}%</span>
          </div>
        )}

        {item.status === 'complete' && item.progress > 0 && (
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressBar, width: '100%', background: '#22c55e' }} />
            <span style={styles.progressLabel}>100%</span>
          </div>
        )}

        {item.error && (
          <div style={styles.queueError}>{item.error}</div>
        )}

        {item.filepath && item.status === 'complete' && (
          <div style={styles.queueFilepath} title={item.filepath}>
            📁 {item.filepath.split('/').pop() || item.filepath}
          </div>
        )}
      </div>

      {item.status === 'complete' && item.filepath && (
        <button
          style={styles.openBtn}
          onClick={() => onOpenFolder(item.filepath!)}
          title="Open folder"
        >
          📂
        </button>
      )}
    </div>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    background: '#0f0f13',
    color: '#e4e4e7',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    background: '#18181f',
    borderBottom: '1px solid #27272a',
    padding: '0 24px',
    height: 56,
    display: 'flex',
    alignItems: 'center',
  },
  headerInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: 860,
    margin: '0 auto',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logoIcon: {
    fontSize: 22,
    background: '#ef4444',
    borderRadius: 6,
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
  } as any,
  logoText: {
    fontWeight: 700,
    fontSize: 18,
    letterSpacing: '-0.3px',
  },
  serverBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#27272a',
    padding: '4px 10px',
    borderRadius: 20,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
  },
  serverLabel: {
    fontSize: 12,
    color: '#a1a1aa',
  },
  main: {
    flex: 1,
    padding: '32px 24px',
    maxWidth: 860,
    margin: '0 auto',
    width: '100%',
    boxSizing: 'border-box',
  },
  card: {
    background: '#18181f',
    border: '1px solid #27272a',
    borderRadius: 12,
    padding: 24,
    marginBottom: 20,
  },
  urlRow: {
    display: 'flex',
    gap: 12,
  },
  urlInput: {
    flex: 1,
    background: '#0f0f13',
    border: '1px solid #3f3f46',
    borderRadius: 8,
    color: '#e4e4e7',
    fontSize: 15,
    padding: '10px 14px',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  btn: {
    background: '#3f3f46',
    color: '#e4e4e7',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s',
    whiteSpace: 'nowrap',
  },
  btnPrimary: {
    background: '#ef4444',
    color: '#fff',
  },
  btnSecondary: {
    background: '#27272a',
    color: '#e4e4e7',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  errorBanner: {
    marginTop: 12,
    background: '#450a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#fca5a5',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  errorIcon: {
    fontSize: 16,
  },
  infoRow: {
    display: 'flex',
    gap: 16,
    marginBottom: 20,
  },
  thumb: {
    width: 140,
    height: 79,
    objectFit: 'cover',
    borderRadius: 6,
    flexShrink: 0,
    background: '#27272a',
  },
  infoMeta: {
    flex: 1,
    overflow: 'hidden',
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 6,
    lineHeight: 1.4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  infoSub: {
    fontSize: 13,
    color: '#71717a',
    marginBottom: 8,
  },
  playlistBadge: {
    display: 'inline-block',
    background: '#1e1b4b',
    color: '#a5b4fc',
    border: '1px solid #3730a3',
    borderRadius: 6,
    padding: '2px 10px',
    fontSize: 12,
    fontWeight: 500,
  },
  controlsRow: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  controlGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 12,
    color: '#71717a',
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  select: {
    background: '#0f0f13',
    border: '1px solid #3f3f46',
    borderRadius: 8,
    color: '#e4e4e7',
    fontSize: 14,
    padding: '8px 12px',
    cursor: 'pointer',
  },
  downloadBtnGroup: {
    display: 'flex',
    gap: 8,
    marginLeft: 'auto',
    alignItems: 'flex-end',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 16,
    marginTop: 0,
  },
  queue: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  queueItem: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    background: '#0f0f13',
    border: '1px solid #27272a',
    borderRadius: 10,
    padding: 14,
  },
  queueThumb: {
    width: 80,
    height: 45,
    objectFit: 'cover',
    borderRadius: 4,
    background: '#27272a',
    flexShrink: 0,
  },
  queueInfo: {
    flex: 1,
    overflow: 'hidden',
    minWidth: 0,
  },
  queueTitle: {
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  queueMeta: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  statusChip: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  queueMetaText: {
    fontSize: 12,
    color: '#71717a',
  },
  progressTrack: {
    position: 'relative',
    background: '#27272a',
    borderRadius: 4,
    height: 6,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressBar: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.3s ease',
  },
  progressLabel: {
    position: 'absolute',
    right: 0,
    top: -18,
    fontSize: 11,
    color: '#71717a',
  },
  queueError: {
    fontSize: 12,
    color: '#f87171',
    marginTop: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  queueFilepath: {
    fontSize: 11,
    color: '#52525b',
    marginTop: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  openBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 20,
    padding: 4,
    borderRadius: 6,
    color: '#71717a',
    flexShrink: 0,
    alignSelf: 'center',
    transition: 'color 0.15s',
  },
  emptyState: {
    textAlign: 'center',
    padding: '80px 24px',
    color: '#52525b',
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 500,
    color: '#71717a',
    marginBottom: 8,
  },
  emptyHint: {
    fontSize: 14,
    color: '#52525b',
  },
};
