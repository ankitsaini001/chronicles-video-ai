#!/usr/bin/env python3
"""Contact sheet for a rendered video (QA, F22b): frames at chosen times in a grid, each labelled.

Usage: python3 tools/video/contact_sheet.py VIDEO.mp4 OUT.png [--times 0.5,1.5,3,...] [--cols 9] [--width 360]

Frames are decoded with Remotion's bundled ffmpeg (node_modules/@remotion/compositor-*) and laid out
with Pillow; nothing is downloaded. Temporary frames go to a folder next to OUT.png (removed after),
never to the system temp folder.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def ffmpeg_dir():
    found = glob.glob(os.path.join(ROOT, "node_modules", "@remotion", "compositor-*", "ffmpeg"))
    if not found:
        sys.exit("Remotion's ffmpeg was not found in node_modules/@remotion/compositor-*")
    return os.path.dirname(found[0])


def run(tool, args):
    d = ffmpeg_dir()
    env = dict(os.environ, LD_LIBRARY_PATH=d)
    return subprocess.run([os.path.join(d, tool)] + args, env=env, check=True, capture_output=True)


def duration(video):
    out = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", video]).stdout
    return float(json.loads(out)["format"]["duration"])


def default_times(total):
    times = [0.5, 1.5, 3.0]
    rest = 15
    start, end = 6.0, max(6.5, total - 0.5)
    times += [round(start + (end - start) * i / (rest - 1), 1) for i in range(rest)]
    return times


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("out")
    p.add_argument("--times", default=None)
    p.add_argument("--cols", type=int, default=9)
    p.add_argument("--width", type=int, default=360)
    a = p.parse_args()

    total = duration(a.video)
    times = [float(t) for t in a.times.split(",")] if a.times else default_times(total)
    times = [t for t in times if t < total]
    work = os.path.join(os.path.dirname(os.path.abspath(a.out)), ".sheet-frames")
    os.makedirs(work, exist_ok=True)
    try:
        frames = []
        for i, t in enumerate(times):
            path = os.path.join(work, f"f{i:02d}.png")
            run("ffmpeg", ["-v", "error", "-y", "-ss", f"{t:.3f}", "-i", a.video, "-frames:v", "1", path])
            frames.append((t, Image.open(path).convert("RGB")))
        w = a.width
        h = round(w * frames[0][1].height / frames[0][1].width)
        label_h = 26
        cols = min(a.cols, len(frames))
        rows = (len(frames) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (w + 6) + 6, rows * (h + label_h + 6) + 6), (128, 128, 128))
        draw = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 16)
        except OSError:
            font = ImageFont.load_default()
        for i, (t, img) in enumerate(frames):
            x = 6 + (i % cols) * (w + 6)
            y = 6 + (i // cols) * (h + label_h + 6)
            draw.rectangle([x, y, x + w, y + label_h], fill=(30, 30, 30))
            draw.text((x + 6, y + 4), f"{t:g}s", fill=(255, 255, 255), font=font)
            sheet.paste(img.resize((w, h), Image.LANCZOS), (x, y + label_h))
        sheet.save(a.out)
        print(f"contact sheet: {a.out} ({len(frames)} frames, video {total:.2f} s)")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
