# YT Downloader

A desktop YouTube video downloader app — built on the foundation of the [Vibe Video Editor](https://github.com/akamrt/Vibe-video-editing-).

> ⚠️ This is a new app branched from Vibe Video Editor. The video editing features are being stripped out and replaced with a focused YouTube download experience.

---

## 🎯 Goal

A clean, simple desktop app to:

- Paste a YouTube URL and download the video
- Choose quality (4K, 1080p, 720p, 480p, audio only)
- Choose format (MP4, MP3, WebM)
- See download progress in real time
- Manage a download queue
- Optional: batch download playlists

---

## 🛠 Tech Stack

- **Electron** + **TypeScript** + **React** (inherited from Vibe Editor)
- **yt-dlp** (Python) for the actual downloading
- **ffmpeg** for format conversion

---

## 🚧 Status

**In development** — stripping out video editor features and building the downloader UI.

---

## 📦 Install (coming soon)

```bash
npm install
npm run electron:dev
```

---

*Forked from [Vibe Video Editor](https://github.com/akamrt/Vibe-video-editing-) by Nathan*
