#!/usr/bin/env python3
"""
YouTube downloader script using yt-dlp.
Usage: python downloader.py <url> <quality> <format> <output_dir>

quality: best | 1080p | 720p | 480p | 360p | mp3
format:  mp4 | webm | mp3
"""

import sys
import json
import os
import subprocess
import re

def emit(obj):
    print(json.dumps(obj), flush=True)

def build_format_selector(quality: str, fmt: str) -> str:
    """Build a yt-dlp format selector string."""
    if quality == "mp3" or fmt == "mp3":
        return "bestaudio/best"
    
    height_map = {
        "1080p": 1080,
        "720p": 720,
        "480p": 480,
        "360p": 360,
    }
    
    if quality == "best":
        if fmt == "webm":
            return "bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo+bestaudio/best"
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"
    
    height = height_map.get(quality)
    if height:
        if fmt == "webm":
            return (
                f"bestvideo[height<={height}][ext=webm]+bestaudio[ext=webm]"
                f"/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
            )
        return (
            f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]"
            f"/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        )
    
    # fallback
    return "bestvideo+bestaudio/best"

def get_output_template(output_dir: str, fmt: str) -> str:
    if fmt == "mp3":
        ext = "mp3"
    elif fmt == "webm":
        ext = "webm"
    else:
        ext = "mp4"
    return os.path.join(output_dir, f"%(title)s.{ext}")

def parse_progress(line: str):
    """Parse yt-dlp progress output into structured dict."""
    # [download]  45.2% of ~100.00MiB at  1.23MiB/s ETA 00:30
    match = re.search(
        r'\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\w+/s).*?ETA\s+([\d:]+)',
        line
    )
    if match:
        return {
            "status": "downloading",
            "progress": float(match.group(1)),
            "speed": match.group(2),
            "eta": match.group(3),
        }
    
    # [download] Destination: /path/to/file
    dest_match = re.search(r'\[download\] Destination: (.+)', line)
    if dest_match:
        return {"status": "downloading", "progress": 0.0, "filepath": dest_match.group(1).strip()}
    
    # Merging / post-processing
    if "[Merger]" in line or "[ffmpeg]" in line or "[ExtractAudio]" in line:
        return {"status": "processing", "progress": 99.0}
    
    return None

def main():
    if len(sys.argv) < 3:
        emit({"status": "error", "message": "Usage: downloader.py <url> <quality> [format] [output_dir]"})
        sys.exit(1)

    url = sys.argv[1]
    quality = sys.argv[2] if len(sys.argv) > 2 else "best"
    fmt = sys.argv[3] if len(sys.argv) > 3 else "mp4"
    output_dir = sys.argv[4] if len(sys.argv) > 4 else os.path.expanduser("~/Downloads")

    os.makedirs(output_dir, exist_ok=True)

    format_selector = build_format_selector(quality, fmt)
    output_template = get_output_template(output_dir, fmt)

    cmd = [
        "yt-dlp",
        "--no-playlist" if "list=" not in url else "--yes-playlist",
        "--cookies-from-browser", "chrome",
        "--format", format_selector,
        "--output", output_template,
        "--newline",           # one progress line per update
        "--no-part",           # no .part files
        "--merge-output-format", fmt if fmt != "mp3" else "mp4",
        "--progress",
    ]

    # Audio-only post-processing
    if quality == "mp3" or fmt == "mp3":
        cmd += ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "0"]

    cmd.append(url)

    emit({"status": "starting", "progress": 0.0, "message": "Starting download..."})

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        last_filepath = None

        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue

            parsed = parse_progress(line)
            if parsed:
                if "filepath" in parsed:
                    last_filepath = parsed["filepath"]
                emit(parsed)
            else:
                # Emit raw line as info for debugging (not status update)
                if line.startswith("[") and "ERROR" in line.upper():
                    emit({"status": "error", "message": line})
                    proc.wait()
                    sys.exit(1)

        proc.wait()

        if proc.returncode != 0:
            emit({"status": "error", "message": f"yt-dlp exited with code {proc.returncode}"})
            sys.exit(1)

        # Try to figure out the final filepath
        if not last_filepath:
            # Best guess from output template
            last_filepath = output_dir

        emit({"status": "complete", "filepath": last_filepath, "progress": 100.0})

    except FileNotFoundError:
        emit({"status": "error", "message": "yt-dlp not found. Please install it: pip install yt-dlp"})
        sys.exit(1)
    except Exception as e:
        emit({"status": "error", "message": str(e)})
        sys.exit(1)

if __name__ == "__main__":
    main()
