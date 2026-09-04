---
name: gifgrep
description: Search Tenor/Giphy and send a GIF into the chat. Use when the user asks for a gif or wants a reaction image — "send me a gif of X", "react with a gif", "post a reaction", etc.
---

# gifgrep

Reactions and memes. Uses the `gifgrep` CLI.

## Triggers

- "send me a gif of…"
- "gif of X"
- "react with a gif of…"
- "post/drop a [funny|sad|celebration] gif"
- Context-driven: a joke lands, the user cheers, something fails — a GIF fits.

Don't use this for illustrations, posters, or generated imagery. Those belong to the `generation` skill.

## Flow

1. Pick 1-3 tight search terms (not full sentences).
2. `gifgrep "<query>" --download --max 1` → downloads to `~/Downloads`.
3. Move the file into the sandbox (`gifs/`), then `send_attachment`.

## Example

```bash
mkdir -p "$EDMUND_SANDBOX_PATH/gifs"
OUT=$(gifgrep "office handshake" --download --max 1 --format url | tail -1)
# the downloaded path is the last file in ~/Downloads matching *.gif
FILE=$(ls -t ~/Downloads/*.gif 2>/dev/null | head -1)
cp "$FILE" "$EDMUND_SANDBOX_PATH/gifs/"
DEST="$EDMUND_SANDBOX_PATH/gifs/$(basename "$FILE")"
```

Then call `send_attachment(file_path=DEST)`. A brief caption is optional — usually the GIF speaks for itself.

## Source selection

- Default auto-routes between Tenor and Giphy. Fine for almost everything.
- `GIPHY_API_KEY` required only if you force `--source giphy`; leave alone.

## Search tips

- Short queries beat long ones: `"cooper celebrating"` > `"a black labradoodle dancing at a hockey game"`.
- Reaction-style queries: `"sure jan"`, `"shocked pikachu"`, `"nice"`, `"nope"`, `"clapping"`.
- Hockey / Casey context: `"hockey goal celebration"`, `"hockey fight"`.

## Anti-patterns

- Searching with a paragraph. Two-three words wins.
- Sending the raw `~/Downloads/*.gif` path — copy into the sandbox first so the file persists with the session.
- Calling gifgrep when the user asked for a *generated* image. Use `generate_image` for that.
- Downloading multiple variants and asking the user to pick. Pick one and send it; they can ask for another.
