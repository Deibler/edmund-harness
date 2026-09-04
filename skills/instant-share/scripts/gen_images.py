#!/usr/bin/env python3
"""Generate the artifact's images directly from OpenRouter and drop them in <artifact>/img/.

Why this exists: the harness `generate_image` MCP tool auto-delivers whatever it makes
straight into the chat, so using it for page assets spams the user with six loose photos
before they ever see the page. This writes to disk and says nothing.

Usage:
    scripts/gen_images.py "$ARTIFACT" shots.json
    echo '{"hero": "a bowl of ..."}' | scripts/gen_images.py "$ARTIFACT" -

shots.json is a flat {"name": "prompt"} map, or {"name": {"prompt": "...",
"aspect_ratio": "3:2"}}. Default aspect ratio is 4:3. Files land at <artifact>/img/<name>.jpg,
resized to 1100px on the long edge.

Reference the results in HTML with data-src, NOT src -- see the Images section of SKILL.md.
"""
import base64, json, os, re, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

MODEL = "google/gemini-3-pro-image-preview"
CONFIG = os.environ.get(
    "EDMUND_CONFIG_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "config.toml"),
)


def api_key():
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    m = re.search(r'openrouter\s*=\s*"([^"]+)"', open(CONFIG).read())
    if not m:
        sys.exit("no openrouter key in env or " + CONFIG)
    return m.group(1)


KEY = None


def one(item):
    name, spec = item
    if isinstance(spec, str):
        spec = {"prompt": spec}
    body = json.dumps({
        "model": spec.get("model", MODEL),
        "modalities": ["image", "text"],
        "image_config": {"aspect_ratio": spec.get("aspect_ratio", "4:3")},
        "messages": [{"role": "user", "content": spec["prompt"]}],
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions", data=body,
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            r = json.load(urllib.request.urlopen(req, timeout=300))
            url = r["choices"][0]["message"]["images"][0]["image_url"]["url"]
            data = base64.b64decode(url.split(",", 1)[1])
            path = os.path.join(OUT, name + ".jpg")
            open(path, "wb").write(data)
            subprocess.run(["sips", "-Z", "1100", "-s", "formatOptions", "72",
                            path, "--out", path], capture_output=True)
            return "%-10s %4dKB" % (name, os.path.getsize(path) // 1024)
        except Exception as e:
            if attempt == 2:
                return "%-10s FAILED %s" % (name, e)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    artifact, shots_path = sys.argv[1], sys.argv[2]
    shots = json.load(sys.stdin if shots_path == "-" else open(shots_path))
    KEY = api_key()
    OUT = os.path.join(artifact, "img")
    os.makedirs(OUT, exist_ok=True)
    failed = 0
    with ThreadPoolExecutor(max_workers=3) as ex:
        for line in ex.map(one, shots.items()):
            print(line, flush=True)
            failed += "FAILED" in line
    sys.exit(1 if failed else 0)
