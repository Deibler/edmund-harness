---
name: generation
description: Comprehensive multimodal generation via OpenRouter — images (with reference photos), videos (text/image/reference-to-video), and spoken audio. Picks models based on task + budget.
---

# Generation (OpenRouter)

Use this for anything beyond a simple one-off image: photo edits using a reference, character consistency across multiple references, style-matched videos, voice memos in a specific voice, etc.

## The tools

Model discovery (always call one of these FIRST so you pick an appropriate model):

- `list_image_models(max_price_usd?, query?)` — filtered by the harness's max image price.
- `list_video_models(max_price_usd?, query?)` — per-second pricing + supported resolutions/ratios.
- `list_audio_models(max_price_usd?, query?)` — audio-output (text-to-speech) models.

Generation (pass `model` from the listing; falls back to configured default if omitted):

- `generate_image(prompt, model?, reference_images?, aspect_ratio?, image_size?)`
- `generate_video(prompt, model?, resolution?, aspect_ratio?, duration?, generate_audio?, frame_images?, reference_images?)`
- `generate_audio(text, model?, voice?, format?)`

All outputs land in the session sandbox (`images/`, `videos/`, `voice-memos/`). Deliver with `send_attachment(path)`.

## When to use reference images

**You almost always should**, when the user has sent anything relevant:

- User sent a photo of themselves and wants an AI version → pass their photo as a reference.
- User wants character X in a scene → pass a photo of X.
- User wants a style match ("make it look like the one from Tuesday") → use that image as reference.
- Edit workflows ("make the fish bigger", "add my dog to this") → pass the source image AND any additions.

The `received-images/` dir inside the sandbox is the first place to look — every image the user has sent is archived there with a dated filename. `ls` that directory and pick the relevant file(s) before calling `generate_image`.

## Picking a model

Price caps are enforced by the harness — anything above them is hidden from the listing. The listing is sorted cheapest-first. Two rules on top of that:

1. **Prefer newer + cheaper variants over their Pro/premium siblings** unless you have a concrete reason not to. Newer model families (Gemini 3.1 Flash Image / Nano Banana 2, gpt-audio-mini, Lyria 3 Clip, Wan 2.5, Seedance) typically match or beat their older Pro counterparts on quality while costing 30-70% less. Don't reach for "Pro" because it sounds better — reach for it only when the task genuinely needs it (long songs, hi-res video with audio, ultra-fine typography).
2. **When two listed models look interchangeable for the task, pick the cheaper one.** You can always re-run with a pricier model if the first result disappoints. You can't refund a $0.14 generation.

Concrete pairs to remember:

- Text-to-image: **`google/gemini-3.1-flash-image-preview` (Nano Banana 2, ~$0.067/img)** over `google/gemini-3-pro-image-preview` (Nano Banana Pro, ~$0.14/img). The Flash is newer, cheaper, and produces better output for most prompts — Jordan has flagged Pro getting picked when Flash would have done better and cost half as much. Only reach for Pro if Flash has failed twice on the same prompt.
- TTS short memos: **`openai/gpt-audio-mini`** over `openai/gpt-4o-audio-preview`. Mini handles one-sentence voice replies fine.
- Music: **`google/lyria-3-clip-preview` ($0.04, 30s)** for jingles and short bits. Only use `lyria-3-pro-preview` ($0.08, full-length with verses + chorus) when the user explicitly asks for a full song.
- Video: cheaper Wan/Seedance first. **`google/veo-3.1` is premium — reach for it only when you need synced audio** or the user asks for Veo by name.

Beyond those:

- **Editing with a reference photo** (far and away the most common user ask — "put a hat on her", "make the fish bigger", "add Cooper in the background"): if you pass `reference_images`, the harness **auto-routes** to an edit-optimized model (FLUX.2 Pro by default). You can override, but FLUX.2 Pro / Max / Sourceful Riverflow V2 Pro preserve faces and composition far better than a text-to-image model like Gemini Flash Image. Never pass the text-to-image default when references are in play — the output will look "similar" instead of "edited".
- **Pure text-to-image** (no reference): Gemini Flash Image (Nano Banana 2) is fast and cheap and fine — use it by default.
- **Character consistency across multiple shots**: `list_image_models(query: "reference consistency")` → pick a multi-reference model.
- **Text in image / typography**: Sourceful Riverflow's `font_inputs` (specialized), or FLUX.2 Pro for general typography.
- **Video with character consistency**: Alibaba Wan, ByteDance Seedance, Google Veo (reference-to-video).
- **Video with sound**: pick a model that supports `generate_audio: true`.
- **Audio — spoken voice memo (TTS)**: `openai/gpt-4o-audio-preview` (default) or `openai/gpt-audio-mini` (cheaper). Voices: alloy, echo, fable, onyx, nova, shimmer. Use when the user says "send me a voice memo", "say it out loud", etc.
- **Audio — singing / music**: `google/lyria-3-pro-preview` ($0.08/song, full-length with verses + chorus) or `google/lyria-3-clip-preview` ($0.04/30-sec clip). Use when the user says "sing about…", "make a song", "write me a jingle". Put the lyrics in the prompt.
- **Picking between TTS and music models**: spoken descriptions → TTS. Anything with melody or "sing" → Lyria. When the user says "voice memo of you *singing*", pick Lyria, not TTS.

Default flow: `list_image_models(query: "editing reference")` → read descriptions → pick → generate. For common edits, just passing `reference_images` and letting the auto-route do its thing is fine.

## Reference-image workflow, by example

User sends a selfie, says "make me into a movie poster":

```
list_image_models({ query: "reference editing" })
# pick e.g. "black-forest-labs/flux.2-pro" — good for references

ls received-images/                                           # find their selfie
# -> 2026-04-19_hhmmss_IMG_1234.jpeg

generate_image({
  prompt: "{user's phrasing about the poster} — make it cinematic, …",
  model: "black-forest-labs/flux.2-pro",
  reference_images: ["/abs/path/received-images/2026-04-19_hhmmss_IMG_1234.jpeg"],
  aspect_ratio: "2:3",
  image_size: "2K"
})
# -> /abs/path/sandbox/<id>/images/YYYY-MM-DD_HHMMSS_poster.png

send_attachment({ file_path: "/abs/path/sandbox/<id>/images/...png" })
```

For multi-reference (character X in scene Y):

```
generate_image({
  prompt: "{scene description}. Character should look like the person in the first reference. Background should match the second reference.",
  model: "{multi-reference-capable model id}",
  reference_images: [characterPhoto, backgroundPhoto],
  aspect_ratio: "16:9"
})
```

For video from a photo:

```
generate_video({
  prompt: "{motion description}",
  model: "google/veo-3.1",
  frame_images: [{ path: photo, frame_type: "first_frame" }],
  resolution: "1080p",
  aspect_ratio: "16:9",
  generate_audio: true
})
```

## Cost, and the re-roll loop

Images are cents. **Video is dollars**, priced per second of output, and it is by
far the easiest way to burn the account down to zero in an evening. On
2026-08-09 a run of video generations drained the OpenRouter balance mid-job and
the next request came back 402 — the person on the other end just saw their clip
die. The fix is not to refuse; it is to spend the money on the right generation
the first time.

**Land the prompt before you spend.** For anything video, and for images with a
lot riding on them, know what you are actually making: subject, what moves,
camera, mood, length, sound or no sound. If the ask is a one-liner and the shot
could go four ways, say the shot back in one sentence and go — or ask the single
question that decides it. One line of clarification is cheaper than a second
render, and much cheaper than a third.

**Notice the loop.** Two generations on the same subject where the second only
moved one small thing is a re-roll loop starting. That is the moment to change
the shape of the conversation, not the moment to fire a third:

> Each of these is a real render, so let's do one good pass instead of five
> small ones. Give me everything you'd change and I'll fold it in together.

Say it once, in voice, at the moment it becomes true. Not as a preamble on the
first request, not every time after. Never itemize what something cost unless
they ask — the point is a better prompt, not guilt.

**Fix it in post when post can fix it.** Text, crop, color, trim, speed, a title
card, stitching two clips: that is ffmpeg and Pillow, free and instant. Only
re-generate when the actual content of the frame has to change. Re-rolling a
whole video to move a caption is the single most expensive mistake available
here.

**Other ways to spend less for the same result:** generate one still first and
animate it (image-to-video with `frame_images`) rather than rolling text-to-video
blind — the still costs cents and you can iterate on composition for free before
committing to seconds of video; keep durations short and the cheaper models first
per the pricing rules above; drop `generate_audio` when nobody is going to hear it.

**On a 402 or "insufficient credits":** the account is out. Do not retry, do not
quietly fall back until something works. Say so plainly, tell whoever owns the
account (Alex), and stop.

## Anti-patterns

- Calling `generate_image` without first `list_image_models` — you may pick a model that's worse or more expensive than you need.
- Re-generating from scratch when the user's photo is already in `received-images/`. Always look there first.
- Constructing absolute paths yourself for reference images. Use the paths the envelope surfaces, or `ls` the dir and use real paths.
- Producing a file and just telling the user "here's your image: /path/..." — you MUST follow with `send_attachment` or they won't see it.
- Firing a fifth video render off a one-word tweak. Two small-change re-rolls in a row means stop and collect the whole list of changes first.
- Regenerating a clip to change something that ffmpeg could have changed for free.
