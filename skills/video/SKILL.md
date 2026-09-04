---
name: video
description: Work with video files — understand what's in a clip, pull frames you can actually look at, edit (trim/join/retime/overlay/re-encode), verify a cut is clean, and deliver it over iMessage. Use whenever someone sends a video, asks for edits to one, or you're producing/forwarding a clip.
---

# video

You can SEE images but not video — so every video task runs on the same loop:
**probe → extract frames → look at them → act → re-extract → verify → send.**
`ffmpeg`/`ffprobe` are installed; run them with Bash in the sandbox.

## Understand a video you received

The envelope usually already carries `[video: 0:14 · 1080×1920 · h264+aac · 18 MB — speech: "…"]` — duration, size, and what was said. From there:

1. **Probe** (if you need more detail):
   `ffprobe -v error -print_format json -show_format -show_streams IN.mov`
2. **Look at it** — extract a contact sheet of small frames and Read them:
   `mkdir -p frames && ffmpeg -v error -i IN.mov -vf "fps=1/2,scale=300:-1" frames/f_%02d.jpg -y`
   (1 frame every 2s at 300px is cheap; ~8–30 frames covers most clips. For a
   fast moment use `fps=6` over a `-ss START -t DUR` window.)
3. **Semantic questions** ("what's happening", "is this funny", reading on-screen text in motion): `analyze_video(file_path, prompt, async:true)` — Gemini watches the whole clip with sound.
4. **Speech only**: it's usually already in the envelope; otherwise `transcribe_audio(file_path)` works on video (audio track is extracted automatically; `async:true` past ~1 min).

## Edit a video

Work in the sandbox; keep the original untouched; name outputs for what they are.

- **Trim** (frame-accurate, re-encode): `ffmpeg -v error -ss 12.5 -to 31.0 -i IN.mov -c:v libx264 -preset veryfast -crf 22 -c:a aac -pix_fmt yuv420p OUT.mp4`
  (`-c copy` is faster but cuts land on keyframes — only for rough cuts.)
- **Join clips**: re-encode each piece to IDENTICAL codec/size/fps first, then concat.
  Stream-copy concat of mismatched clips causes smeared/glitchy boundaries — if you
  see smear at a joint, re-encode the pieces (or use the `concat` FILTER, not the demuxer).
- **Speed**: video `-vf "setpts=PTS/2"` + audio `-af "atempo=2"` (0.5–2.0 per atempo stage, chain for more). For slow-mo without judder add `minterpolate` or accept the source fps.
- **Text/title plate**: `drawtext=text='RUSH 2026':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0,2.5)'` — or render a PNG card and `overlay` it (fade with `format=rgba,fade=...:alpha=1`).
- **Audio**: normalize speech with `-af loudnorm=I=-16:TP=-1.5`; duck/replace music by mixing with `amix`/`volume`.
- **Captions**: burn an .srt with `-vf subtitles=subs.srt` (write the .srt from the transcript).

**Verify EVERY render before calling it done**: re-extract a contact sheet of the
OUTPUT and look at it — check cut boundaries (grab `fps=8` for ±1s around each
joint), title timing, and that motion is real (adjacent frames must differ).
Bad renders you can catch this way: frozen video, smeared joints, black frames,
wrong aspect. Listen-check isn't possible — check loudness stats instead:
`ffmpeg -i OUT.mp4 -af volumedetect -f null - 2>&1 | grep -E "mean|max"`.

## Send a video

`send_attachment(path)` — the harness auto-re-encodes anything too heavy or in an
iMessage-hostile format (webm/mkv/vp9/av1) to h264+aac mp4 ≤ ~15 MB. Still, prefer
exporting deliverable files yourself: `-c:v libx264 -crf 23 -pix_fmt yuv420p -c:a aac -movflags +faststart` and keep casual clips ≤ 1080p / a couple of minutes. The
tool result tells you if a converted copy was sent.

## Generate a video from scratch / from a photo

That's the `generation` skill (`generate_video`, OpenRouter models) — not this one.
Read its cost section before you roll a second take: video is priced per second,
and most "can you change one thing" requests are an ffmpeg edit here, not a new
render.

## Pace yourself honestly

Long renders are fine inline — the session stays locked to you while you're actively
working, however long that takes. But the human is waiting: send_message a one-line
heads-up ("cutting it now, ~2 min") before a slow multi-render pass, and again if
the plan changes. Don't narrate every command.
