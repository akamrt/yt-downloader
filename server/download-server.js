/**
 * download-server.js
 * Local Express server for YouTube downloader.
 * Runs on port 3002 (separate from the main VibeCut server on 3001).
 *
 * Endpoints:
 *   POST /info          — fetch video metadata via yt-dlp --dump-json
 *   POST /download      — start a download, returns { id }
 *   GET  /progress/:id  — SSE stream of download progress
 *   GET  /api/health    — health check
 */

'use strict';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.DOWNLOAD_SERVER_PORT || 3002;

app.use(cors());
app.use(express.json());

// ---- helpers ----

function getPythonBin() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getDownloaderScript() {
  // Works in both dev (repo root) and packaged (resources)
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'python', 'downloader.py');
  }
  return path.join(__dirname, '..', 'python', 'downloader.py');
}

function getDownloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

// ---- in-memory download queue ----

const downloads = new Map();
// { id: { status, progress, speed, eta, filepath, error, sseClients: Set } }

function createDownload(id) {
  const dl = {
    id,
    status: 'queued',
    progress: 0,
    speed: null,
    eta: null,
    filepath: null,
    error: null,
    title: null,
    thumbnail: null,
    sseClients: new Set(),
  };
  downloads.set(id, dl);
  return dl;
}

function broadcastToDownload(id, event) {
  const dl = downloads.get(id);
  if (!dl) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of dl.sseClients) {
    try { res.write(data); } catch (_) {}
  }
  if (event.status === 'complete' || event.status === 'error') {
    for (const res of dl.sseClients) {
      try { res.end(); } catch (_) {}
    }
    dl.sseClients.clear();
  }
}

// ---- routes ----

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'yt-downloader' });
});

// Get video info
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const args = [
    '--dump-json',
    '--no-playlist',
    '--cookies-from-browser', 'chrome',
    url,
  ];

  let raw = '';
  let errRaw = '';

  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => { raw += d.toString(); });
  proc.stderr.on('data', d => { errRaw += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: `yt-dlp exited ${code}`, detail: errRaw.slice(0, 500) });
    }
    try {
      // yt-dlp may emit multiple JSON objects for playlists; take the first
      const firstLine = raw.trim().split('\n')[0];
      const info = JSON.parse(firstLine);

      const formats = (info.formats || [])
        .filter(f => f.height || f.acodec !== 'none')
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          height: f.height || null,
          vcodec: f.vcodec,
          acodec: f.acodec,
          filesize: f.filesize || f.filesize_approx || null,
        }));

      // Check if playlist
      const isPlaylist = info._type === 'playlist' || !!info.playlist_count;

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader,
        view_count: info.view_count,
        description: (info.description || '').slice(0, 300),
        formats,
        is_playlist: isPlaylist,
        playlist_count: info.playlist_count || null,
        webpage_url: info.webpage_url || url,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse yt-dlp output', detail: e.message });
    }
  });
});

// Start a download
app.post('/download', (req, res) => {
  const { url, quality = 'best', format = 'mp4', outputDir } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const id = randomUUID();
  const dl = createDownload(id);
  dl.status = 'starting';

  const downloadsDir = outputDir || getDownloadsDir();
  const pythonBin = getPythonBin();
  const script = getDownloaderScript();

  const proc = spawn(pythonBin, [script, url, quality, format, downloadsDir]);

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        // Update in-memory state
        dl.status = evt.status || dl.status;
        if (evt.progress !== undefined) dl.progress = evt.progress;
        if (evt.speed) dl.speed = evt.speed;
        if (evt.eta) dl.eta = evt.eta;
        if (evt.filepath) dl.filepath = evt.filepath;
        if (evt.message) dl.lastMessage = evt.message;

        broadcastToDownload(id, { ...evt, id });
      } catch (_) {
        // Non-JSON line from yt-dlp — ignore
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[downloader ${id}] stderr:`, msg);
  });

  proc.on('close', (code) => {
    if (code !== 0 && dl.status !== 'complete' && dl.status !== 'error') {
      dl.status = 'error';
      dl.error = `Process exited with code ${code}`;
      broadcastToDownload(id, { id, status: 'error', message: dl.error });
    }
  });

  res.json({ id, status: 'starting' });
});

// SSE progress stream
app.get('/progress/:id', (req, res) => {
  const { id } = req.params;
  const dl = downloads.get(id);

  if (!dl) return res.status(404).json({ error: 'Download not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ id, status: dl.status, progress: dl.progress, speed: dl.speed, eta: dl.eta, filepath: dl.filepath })}\n\n`);

  if (dl.status === 'complete' || dl.status === 'error') {
    res.end();
    return;
  }

  dl.sseClients.add(res);

  req.on('close', () => {
    dl.sseClients.delete(res);
  });
});

// List all downloads
app.get('/downloads', (_req, res) => {
  const list = [];
  for (const [id, dl] of downloads.entries()) {
    list.push({
      id,
      status: dl.status,
      progress: dl.progress,
      speed: dl.speed,
      eta: dl.eta,
      filepath: dl.filepath,
      title: dl.title,
      thumbnail: dl.thumbnail,
      error: dl.error,
    });
  }
  res.json(list);
});

// ---- start ----

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[yt-downloader] Server running on http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
