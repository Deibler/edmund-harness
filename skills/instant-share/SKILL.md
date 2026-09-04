---
name: instant-share
description: Share interactive web artifacts via secure, verified public URLs. Build React apps, multiplayer games, dashboards, reports. Features auth tokens, admin panel, auto-expire, and link verification. Uses free Cloudflare Quick Tunnels.
---

# Instant Share

Share interactive web artifacts with verified URLs, admin controls, and automatic expiration. Supports static pages, React apps, multiplayer games, and sophisticated web applications.

---

## STOP - READ THIS FIRST

**Before you do ANYTHING with this skill, understand these rules:**

1. **ALWAYS use create_artifact.sh first** - This creates the artifact.json manifest (required)
2. **NEVER send a link until you see "Verified working"** in share.sh output
3. **NEVER mention, promise, or construct URLs yourself** - Only use URLs from share.sh output
4. **Read DESIGN.md before creating content** - No emojis, no purple, no gradients

**Where artifacts live:** `create_artifact.sh` creates directories inside the current conversation's sandbox automatically (via `$INSTANT_SHARE_ARTIFACT_DIR`, set by the harness). You do NOT need to pass paths — just run the scripts and the artifact lands in `sandbox/<this-conversation>/artifact_<id>/`. Everything you build for this thread stays scoped to it.

**Why create_artifact.sh is mandatory:**
- Creates `artifact.json` - the manifest that tracks name, purpose, status, URLs, and metadata
- Creates the proper directory structure with correct permissions
- Enables validation before sharing (share.sh checks for artifact.json)
- Without artifact.json, you're just sharing random files with no tracking

If you skip create_artifact.sh or send links before verification, **you will break things**.

---

## Agent Response Protocol (MANDATORY)

When a user asks you to share something, follow this EXACT conversational pattern:

```
User: "Create a shareable report about X"

Agent: "I'll create that report for you."
       *runs create_artifact.sh to create artifact directory*
       *writes content to $ARTIFACT/index.html*
       *runs share.sh and WAITS for output*
       *reads share.sh output, finds "Verified working" and the URL*

Agent: "Here's your report: [URL from share.sh output]"
```

**CRITICAL:** You must NOT send any message containing a URL until AFTER share.sh completes and shows "Verified working".

### What "Verified working" looks like:

```
============================================================
VERIFIED LIVE URL:

   https://example-words.trycloudflare.com/?key=TOKEN

============================================================

Status: Verified working
```

Only the URL shown in this output block is safe to send.

---

## Common Mistakes (DO NOT DO THESE)

### Mistake 1: Sending link before verification
```
WRONG:
Agent: "Here's your link: https://..."  <- Sent BEFORE running share.sh
Agent: *runs share.sh*                  <- Too late, link may be broken

RIGHT:
Agent: *runs share.sh*
Agent: *waits for "Verified working"*
Agent: "Here's your link: https://..."  <- Safe, URL is from output
```

### Mistake 2: Constructing URLs yourself
```
WRONG:
Agent: *sees tunnel URL in logs*
Agent: "Your link is https://xxx.trycloudflare.com/?key=abc"  <- NEVER construct URLs

RIGHT:
Agent: *copies exact URL from share.sh "VERIFIED LIVE URL" output*
```

### Mistake 3: Skipping create_artifact.sh (no artifact.json)
```
WRONG:
Agent: *writes HTML to random temp file*
Agent: share.sh /tmp/myfile.html         <- No artifact.json = validation fails

RIGHT:
Agent: ARTIFACT=$(create_artifact.sh --name "Report" --purpose "For user")
       # ^^^ This creates artifact.json with name, purpose, timestamps, status
Agent: *writes content to $ARTIFACT/index.html*
Agent: share.sh "$ARTIFACT" --background  <- Validates artifact.json exists
```

**artifact.json is the source of truth.** It stores:
- Artifact name and purpose
- Creation/update timestamps
- Status (building/ready)
- Public URL and admin URL (after sharing)
- Verification status

Without it, the artifact system cannot track or validate your share.

### Mistake 4: Using --html shortcut
```
WRONG:
Agent: share.sh --html "<h1>Hello</h1>"   <- Bypasses artifact system

RIGHT:
Agent: ARTIFACT=$(create_artifact.sh --ready --name "Quick Share")
Agent: echo "<h1>Hello</h1>" > "$ARTIFACT/index.html"
Agent: share.sh "$ARTIFACT" --background
```

---

## Quick Start

**Standard workflow (content ready before sharing):**

```bash
# Step 1: Create artifact directory
ARTIFACT=$(./scripts/create_artifact.sh \
  --name "My Dashboard" \
  --purpose "Sales metrics for Q1" \
  --ready)

# Step 2: Build your content FIRST
cat > "$ARTIFACT/index.html" << 'EOF'
<!DOCTYPE html>
<html><head><title>Dashboard</title></head>
<body><h1>Sales Dashboard</h1><p>Q1 metrics here...</p></body>
</html>
EOF

# Step 3: Share and WAIT for verification
./scripts/share.sh "$ARTIFACT" --background --expire 60
# ^^^ DO NOT send any link to user until this outputs "Verified working"

# Step 4: ONLY NOW send the URL from the output to the user
```

**Loading page workflow (for long-running builds):**

Only use this pattern when content takes a long time to generate:

```bash
# Create artifact (no --ready flag = shows loading page)
ARTIFACT=$(./scripts/create_artifact.sh \
  --name "Complex Report" \
  --purpose "Detailed analysis")

# Share first - visitors see loading page
./scripts/share.sh "$ARTIFACT" --background
# Wait for "Verified working" before sending link!

# Build content (can take time)
# ... generate complex content ...
echo '<h1>Report</h1>' > "$ARTIFACT/index.html"

# Mark ready - visitors auto-refresh to content
./scripts/mark_ready.sh "$ARTIFACT"
```

## Commands

### create_artifact.sh

Example with all options:

```bash
ARTIFACT=$(scripts/create_artifact.sh \
  --name "Artifact Name" \
  --purpose "Why this exists" \
  --description "Detailed description" \
  --group-chat "id:15" \
  --expire 30 \
  --ready)  # Skip loading page

# All flags are optional. Minimal usage:
ARTIFACT=$(scripts/create_artifact.sh)
```

### share.sh

**Always share artifact directories created by create_artifact.sh:**

```bash
# Share artifact directory (RECOMMENDED)
scripts/share.sh "$ARTIFACT" --background

# Share with custom expiration (2 hours)
scripts/share.sh "$ARTIFACT" --background --expire 120
```

Background mode is the default. Use `--foreground` only for interactive
debugging; a normal share must return after verification so it cannot pin an
Edmund turn open. Expiration is an active lease: the server exits on its own and
the daemon reaper terminates only the matching quick-tunnel PID.

**Deprecated shortcuts (avoid these):**

The following work but bypass the artifact system. Do not use them:

```bash
# DEPRECATED: Share single file (no artifact.json)
# scripts/share.sh /path/to/page.html --background

# DEPRECATED: Share inline HTML (no artifact.json)
# scripts/share.sh --html "<h1>Hello</h1>" --background
```

Instead, always use create_artifact.sh first, then share the directory.

### list_artifacts.sh

```bash
# List all artifacts with metadata (human readable)
scripts/list_artifacts.sh

# JSON output for programmatic use
scripts/list_artifacts.sh --json
```

Example output:
```
Artifacts
===========
Sales Dashboard
   Path: /tmp/artifact_a1b2c3d4
   Purpose: Weekly review meeting
   Created: 2026-02-04T03:00:00Z
   Status: ready
   Group: id:15
```

### list_tunnels.sh

```bash
# List all active tunnels with status
scripts/list_tunnels.sh

# JSON output
scripts/list_tunnels.sh --json
```

Example output:
```
  Super Bowl LX Parlay Research
    Status:  live (server: running, tunnel: running)
    URL:     https://example.trycloudflare.com/?key=TOKEN
    Path:    /tmp/artifact_abc123
    Started: 2026-02-05T20:15:43Z
    Expires: 180 minutes

Total: 1 tunnel(s)
```

### stop.sh

**Multiple concurrent tunnels are supported.** Each share.sh call creates an independent tunnel. New shares do NOT tear down existing ones.

```bash
# Stop ALL tunnels
scripts/stop.sh

# Stop a specific tunnel by artifact ID or path
scripts/stop.sh artifact_abc123
scripts/stop.sh /tmp/artifact_abc123

# Stop but keep artifact files
scripts/stop.sh --keep-artifact
```

## artifact.json Manifest

Every artifact has an artifact.json file (source of truth). This file is automatically created and updated by the scripts.

Example structure (values will be specific to your artifact):

```json
{
  "name": "Sales Dashboard",
  "description": "Q1 2026 sales metrics",
  "purpose": "Weekly review meeting",
  "artifact_id": "artifact_a1b2c3d4",
  "created_at": "2026-02-04T03:00:00Z",
  "updated_at": "2026-02-04T03:15:00Z",
  "group_chat_id": "id:15",
  "expire_minutes": 60,
  "status": "ready",
  "public_url": "https://xxx.trycloudflare.com/?key=TOKEN",
  "admin_url": "https://xxx.trycloudflare.com/admin/?key=TOKEN",
  "verified": true
}
```

Fields are populated from create_artifact.sh flags and updated by share.sh when tunnel is established.

## Admin Link Footer

Every artifact automatically gets an admin link in the footer. This happens in two ways:

1. **Templates with placeholder**: If your HTML contains `{{ADMIN_URL}}`, share.sh replaces it with the actual admin URL
2. **Custom HTML**: If your HTML has `</body>` but no placeholder, share.sh automatically injects an admin footer before `</body>`

You don't need to do anything - the admin link is added automatically when you run share.sh.

## Admin Panel

Access URL format: `https://[tunnel-url]/admin/?key=TOKEN`

The actual admin URL is output by share.sh when the tunnel starts. Example:
```
https://xxx.trycloudflare.com/admin/?key=TOKEN
```

Password: set via `INSTANT_SHARE_ADMIN_PASSWORD` (daemon injects it from `[instant_share].admin_password` in config.toml); never hardcoded.

Features:
- View artifact metadata (from artifact.json)
- See request log (last 100 requests with timestamps, paths, status codes)
- Kill artifact immediately (stops serving, shows "Unavailable" page)
- Set/change expire timer (in minutes)
- View server status (started time, request count, expiration)

## Security Model

| Feature | Implementation |
|---------|----------------|
| Auth required | `?key=TOKEN` in URL, no key = 403 |
| Link verification | URL tested with curl before output |
| Single artifact | Only serves specified file/directory |
| No directory listing | Returns 403 |
| No path traversal | `../` blocked, paths resolved and validated |
| Internal files hidden | `_status`, `artifact.json` not accessible |
| Admin protected | Separate password, session tokens |
| Auto-expire | Configurable, default 60 minutes |

## Link Verification

The share.sh script:
1. Starts local server, verifies it responds
2. Establishes Cloudflare tunnel
3. Waits 5 seconds for tunnel stabilization
4. Tests public URL up to 10 times (2 sec intervals)
5. Only outputs URL after HTTP 200 confirmed
6. Fails with error if verification fails

No URL is ever output unless verified working.

## File Structure

Example artifact directory (ID is randomly generated):

```
/tmp/artifact_a1b2c3d4/
  artifact.json    # Manifest (source of truth) - auto-generated
  _status          # Contains "building" until ready (then deleted)
  index.html       # Main content - you create this
  style.css        # Optional - add if needed
  script.js        # Optional - add if needed
```

## Re-serving Artifacts

To find and re-serve a previously created artifact:

```bash
# List all artifacts to find the one you want
./scripts/list_artifacts.sh

# Re-serve an existing artifact (use actual path from list output)
./scripts/share.sh /tmp/artifact_abc123/ --background
```

The list command shows name, purpose, created date, and path for each artifact.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `INSTANT_SHARE_CONFIG_DIR` | `<data_dir>/instant-share` (daemon) / `skills/instant-share/.config` (standalone) | Config/state |
| `INSTANT_SHARE_ARTIFACT_DIR` | `/tmp` | Artifact location |

## Images (MANDATORY)

**Every artifact ships with images. A wall of text is a failed artifact.**

The one exemption is a live data view — an inventory, a tracker, a dashboard whose
whole job is current numbers. Those are read like an instrument, not like an
article, and stock photography on one is decoration. Everything else needs images.

Minimum bar for any content page:

- **One hero image of the thing itself**, directly under the headline and dek. A recipe gets a photo of the finished plate. A build guide gets the finished build. A place gets the place. If the page is about a physical thing and the reader cannot see it, you have not finished the page.
- **An image at every step or section where the reader has to judge something visually.** "Cook it until it darkens" is a guess without a photo; with one it is a test they can pass. Illustrate the make-or-break moments, not all of them evenly.
- **A caption under each one** that says something the photo alone does not. `figcaption` is where the actual instruction goes ("the trail is the test, if it fills back in keep going"), not a restatement of the alt text.
- Alt text on every `<img>`, real width/height attributes so the page does not reflow as they load.

Four to eight images on a long page is the right order of magnitude. Two is thin. Twenty is a slideshow.

### Generating them

Use `scripts/gen_images.py`, which calls OpenRouter directly and writes to `<artifact>/img/`:

```bash
cat > /tmp/shots.json <<'EOF'
{
  "hero":   {"prompt": "<detailed scene>. <style block>", "aspect_ratio": "3:2"},
  "step_4": "<detailed scene>. <style block>"
}
EOF
scripts/gen_images.py "$ARTIFACT" /tmp/shots.json
```

Do **not** use the `generate_image` MCP tool for page assets. It auto-delivers every image it makes into the chat, so the user gets six loose photos in their thread before they ever open the link.

Write one style block and paste it into the end of every prompt, so the set looks like it came from one camera. State the medium, the light, the surface, and what to leave out. Ban text explicitly, models love to hallucinate labels and signage. Realistic beats pretty: an ordinary counter and a worn pan reads as true, a styled magazine shot reads as stock and undercuts the whole page.

### Serving them (the gotcha)

The server requires the access key on **every** request, images included. A plain `<img src="img/hero.jpg">` gets a 403 and you ship a page full of broken frames. Use `data-src` and attach the key at load:

```html
<img data-src="img/hero.jpg" width="1100" height="733" alt="...">
...
<script>
  (function(){
    var k = new URLSearchParams(location.search).get('key') || '';
    var q = k ? '?key=' + encodeURIComponent(k) : '';
    document.querySelectorAll('img[data-src]').forEach(function(i){
      i.src = i.getAttribute('data-src') + q;
    });
  })();
</script>
```

After sharing, curl one image with the key and confirm a 200 and a real byte count. `share.sh` verifies `index.html` only, so a page of broken images still reports "Verified working".

### Layout check before you send

Load the live URL at phone width and screenshot it. Grid and flex step layouts are the usual culprit: with `grid-template-columns:44px 1fr` on the `<li>`, auto-placement drops the *second* child into the 44px counter column and you get one word per line. Pin it:

```css
ol.steps > li{display:grid; grid-template-columns:44px minmax(0,1fr)}
ol.steps > li::before{grid-column:1; grid-row:1 / span 99}
ol.steps > li > *{grid-column:2}
```

## Step-by-step pages (recipes, how-tos, setup guides)

Someone following a page with their hands busy reads differently than someone browsing. Every step gets the same four parts, in this order, every time:

1. **A title** in plain language that says what the step accomplishes. "Cook the salsa down until it fries", not "Step 9". They should be able to scan the titles alone and know the shape of the job.
2. **A quantified list of what goes into that step** — every ingredient, part or setting, with its amount, in a tinted block at the top. Not prose, not "the spices from above". If they have to scroll back up to a master list to find out how much, the step has failed. Repeating an amount in three different steps is correct, not redundant.
3. **The action**, one instruction at a time, no parallel tasks even where a pro would overlap them.
4. **A "done when" cue** they can actually check — a look, a sound, a texture, a time. "Until it darkens and dragging the spoon leaves a dry trail" beats "until reduced".

A master list of everything still goes near the top for gathering and shopping, but label it as that and say the steps repeat their own amounts. Where a step is judged by eye, put an image in it (see Images above).

Ordering rule: sequence the steps so the reader is never watching two things at once. Finish and set aside anything that can be finished early, even when a restaurant kitchen would run them in parallel.

**Name the container and what is already in it.** The most common vagueness in a step-by-step page is an instruction that says what to do but not *where*. "Pour the salsa in and stir it through" reads fine to someone who already knows the dish and is genuinely ambiguous to someone who does not — in, where? A new pan? The one with the beef? Every step that acts on an in-progress thing states the vessel by name and what is currently in it, both as the first line of the ingredient block ("The beef and onion, still in the big skillet") and inside the sentence. Where the page uses more than one container, say so up front — how many, which steps use which, and what never moves between them. The same rule applies outside cooking: which file, which terminal, which browser tab, which directory.

**Technique diagrams, not prose and not AI photos (Alex, 2026-08-13).** When a step uses a technique word — dice, mince, julienne, sear color, sauce thickness — show a diagram of what the word physically means, at the step where it first appears. A reusable hand-drawn SVG library lives at `skills/kitchen/techniques/` (see its `manifest.json` for style rules and the wanted-next list); copy what you need into the artifact's `img/` and add new diagrams to the library, matching its style, when a page needs one that doesn't exist yet. Include the to-scale `cut-sizes.svg` chart whenever the page uses a cut word. Alex asked for real diagrams specifically because generated photos don't teach the term. Pair each diagram with an embedded YouTube clip of a real chef doing it (youtube-nocookie iframe in a 16:9 wrapper, lazy-loaded) — there is no openly-licensed still-photo dataset of knife technique steps online (checked 2026-08-13: Commons has none, cooking-site photo sets are copyrighted), but technique videos by real chefs are embeddable for free and show speed/hand position better than any still. Verified picks: Gordon Ramsay dicing an onion (dCGS067s0zo), Jacques Pepin chopping garlic (1y5h1pDHhzs). Diagram carries the exact dimensions, video carries the motion.

**Embedded timers (Alex, 2026-08-13).** Every timed instruction gets a tap-to-start timer button inside that step (`data-sec`, mm:ss face, pause/reset controls, beep + vibrate at zero, and a sticky bottom bar showing all running timers with their step numbers so a scrolled-away timer stays visible). Multi-phase steps get one button per phase ("2:00 heat the pan", "3:00 first side", "3:00 second side"). Never write "cook 5 minutes" without a timer button next to it. Layout rule (Alex, 2026-08-13): the phase label ("Garlic, stir the whole time") goes on its own full-width line BELOW the time+buttons row, never squeezed as a column between the clock and the Start button — at phone width that column wraps one word per line and gets cut. Also: one widget per step that runs phases sequentially (Start next after each chime), never side-by-side simultaneously-startable buttons.

**Two-cook mode (Alex, 2026-08-13).** Recipe pages get a subtle fixed bottom nav: "One cook" (default, always the full list) plus "Cook 1" / "Cook 2". In a cook view the other cook's steps stay in place but collapse to a one-line ghost, so numbering and the full picture survive, and dashed sync callouts appear at handoff points ("wait for Cook 1 to finish step 9, the skillet comes to you"). Split the work so each cook's steps are sequential for them: one cook takes pans/protein, the other takes knife work/sauce/pasta, with the handoff explicit. Default must stay one cook.

The working reference implementation for all three is `artifact_7a1fc77c755e42fd` in the dm_15550100001 sandbox (pork chops + tortellini, 2026-08-13).

## Getting an answer back from a page

A page can report something to you. `POST /callback?key=<key>` with a JSON object
appends it to `<artifact>/_callbacks.jsonl`, and `GET /callbacks?key=<key>&cb=<callback_token>`
reads them back. The `callback_token` lives in the artifact's `artifact.json` and
is never printed into the page, so a link holder can send a note without being
able to read what anyone else sent. `_callbacks.jsonl` is not servable.

Use it for the one question a page cannot answer on its own: did the thing
actually happen. Pair it with a `set_trigger` on the `/callbacks` URL so a tap
wakes you, and dedupe in the trigger's `state` on the entry timestamp. Give every
action an undo that posts its own event — a mis-tap you never hear about is worse
than no button. `skills/kitchen/templates/made_button.html` is a working example.

## Design Philosophy - THINK BEYOND TEMPLATES

Before building, ask yourself: **"Would someone mistake this for an AI-generated template?"**

If yes, start over.

### The AI Slop Checklist

If you're doing 3+ of these, you're making slop:

- Dark theme with blue accent (the default of every AI tool)
- Three cards in a row with identical structure
- "View details →" on everything
- Generic copy: "AI-powered platform for X", "The modern Y for Z"
- Unicode symbols as icons (◫ ◧ ▤)
- Dashed or gradient borders on cards
- "Trusted by 10K+ users" with no real company names
- Stats without context (just big impressive numbers)
- Everything is a rounded card with shadow
- Massive empty space because there's nothing real to show
- "Welcome to [Product]" / "Manage your products and organizations"

### What Makes Design Feel Real

**Have opinions in your copy:**
- BAD: "The modern deployment platform for teams"
- GOOD: "Deploy without the ceremony"
- BAD: "Manage your products and organizations"  
- GOOD: "We got tired of tools that feel like filing taxes"

**Be specific, not generic:**
- BAD: "Fast rollbacks"
- GOOD: "Average rollback time: 1.2 seconds"
- BAD: "Used by thousands of companies"
- GOOD: "Lattice, Ramp, Mercury, Watershed" (real names)
- BAD: "JD, CTO at TechCo"
- GOOD: "Sam Chen, Head of Engineering at Lattice"

**Show the product, don't describe features:**
- Instead of 6 feature cards, show one screenshot of the actual interface
- Instead of "Real-time logs", show a mock log viewer with real-looking entries
- Instead of describing, demonstrate

**Make unexpected creative choices:**
- Serif fonts for headlines (Times, Georgia) - not everything needs Inter/system fonts
- Light themes - dark isn't automatically "professional"
- Asymmetric layouts - break out of the grid
- Dense information - real products have data to show
- Editorial voice - write like a human with opinions, not a marketing team

**Typography creates hierarchy without cards:**
- Size, weight, and color separate content without boxing everything
- A well-set paragraph is more powerful than a feature card
- Let content breathe through line-height and margins, not containers

### Reference: Sites That Don't Feel AI-Generated

Study these for inspiration:
- Linear.app - bold typography, opinionated copy, purposeful animation
- Stripe.com - deep detail, real code examples, asymmetric layouts  
- Vercel.com - minimal, data-forward, text-based navigation
- Notion.so - playful, illustrations, personality in every detail
- Arc.net - unconventional layout, editorial magazine feel

### The Final Test

Before shipping, ask: "Does this look like a template?"

If you hesitate, iterate until it doesn't.

---

## Design Guidelines - TECHNICAL RULES

All artifacts MUST follow these rules. No exceptions.

**BANNED (validation will block these):**
- Emojis anywhere in the UI
- Purple colors (any shade)
- Gradients of any kind
- Glow/neon effects
- "AI slop" aesthetics (teal+purple, floating shapes, glassmorphism)

**ENCOURAGED (be creative):**
- Bold aesthetic directions (minimalist, brutalist, editorial, luxury, etc.)
- Distinctive typography via Google Fonts
- Dark OR light themes - vary based on context
- CSS animations and micro-interactions
- Noise textures, dramatic shadows, layered transparencies
- React, Vue, or modern frameworks via CDN
- Motion libraries (Framer Motion, GSAP), Three.js for 3D
- Asymmetric layouts, grid-breaking elements
- Interactive games with Canvas API, game loops
- Multiplayer games with WebSockets or PeerJS
- Real-time collaboration features
- Sound effects via Web Audio API
- Local storage for game saves and persistence

**REQUIRED:**
- Mobile viewport meta tag
- `</body>` tag (for admin link injection)
- Readable text with sufficient contrast
- Intentional, cohesive design choices

**Full design specification:** `./references/DESIGN.md`

**READ DESIGN.md BEFORE CREATING ANY ARTIFACT.** It contains:
- Creative philosophy for distinctive, production-grade interfaces
- Design thinking framework (purpose, tone, differentiation)
- Typography, color, motion, and spatial composition guidelines
- React/Vue setup, game development patterns, multiplayer architecture
- Pre-flight checklist

Claude is capable of extraordinary creative work. Don't hold back - commit fully to a distinctive vision that is unforgettable.

## Templates

Pre-built HTML templates for common artifact types. All follow the design guidelines.

### Available Templates

| Template | Description |
|----------|-------------|
| `research-report` | Academic/business report with executive summary, findings, sections |
| `file-download` | Clean download page with file info, checksum support |
| `blog` | Blog post with author, date, featured image, tags |
| `news-article` | News article with byline, lead paragraph, related links |

### Quick Start

```bash
# List available templates
scripts/from_template.sh --list

# See variables for a template
scripts/from_template.sh -t research-report --show

# Generate from template (creates artifact automatically)
ARTIFACT=$(scripts/from_template.sh -t research-report \
  -v TITLE="Q1 Market Analysis" \
  -v AUTHOR="Edmund" \
  -v DATE="February 2026" \
  -v EXECUTIVE_SUMMARY="Key findings from our analysis..." \
  -v KEY_FINDINGS="<div class='finding-item'><span class='finding-num'>1</span><span>Revenue up 23%</span></div>" \
  -v BACKGROUND="<p>Background context here...</p>" \
  -v ANALYSIS="<p>Detailed analysis...</p>" \
  -v RECOMMENDATIONS="<ul><li>Recommendation 1</li></ul>")

# Share it
scripts/share.sh "$ARTIFACT" --background
scripts/mark_ready.sh "$ARTIFACT"
```

### Template Examples

**Research Report:**
```bash
scripts/from_template.sh -t research-report \
  -v TITLE="Competitive Analysis: Q1 2026" \
  -v SUBTITLE="Market positioning and opportunities" \
  -v AUTHOR="Research Team" \
  -v DATE="February 2026" \
  -v EXECUTIVE_SUMMARY="This report analyzes..." \
  -v KEY_FINDINGS="<div class='finding-item'><span class='finding-num'>1</span><span>Finding one</span></div><div class='finding-item'><span class='finding-num'>2</span><span>Finding two</span></div>" \
  -v BACKGROUND="<p>Industry context...</p>" \
  -v METHODOLOGY="<p>Data sources and approach...</p>" \
  -v ANALYSIS="<p>Detailed findings...</p>" \
  -v RECOMMENDATIONS="<ul><li>Action item 1</li><li>Action item 2</li></ul>" \
  -v SOURCES="<ol><li>Source 1</li><li>Source 2</li></ol>"
```

**File Download:**
```bash
scripts/from_template.sh -t file-download \
  -v FILENAME="annual-report-2025.pdf" \
  -v FILE_EXT="PDF" \
  -v FILE_SIZE="4.2 MB" \
  -v FILE_TYPE="PDF Document" \
  -v DESCRIPTION="Annual financial report for fiscal year 2025" \
  -v DOWNLOAD_URL="./annual-report-2025.pdf" \
  -v EXPIRES="in 60 minutes" \
  -v CHECKSUM="a1b2c3d4e5f6..."
```

**Blog Post:**
```bash
scripts/from_template.sh -t blog \
  -v TITLE="How We Scaled to 1M Users" \
  -v CATEGORY="Engineering" \
  -v AUTHOR="Edmund" \
  -v AUTHOR_INITIAL="E" \
  -v DATE="February 4, 2026" \
  -v READ_TIME="8" \
  -v CONTENT="<p>First paragraph...</p><h2>The Challenge</h2><p>More content...</p>" \
  -v TAGS="<span class='tag'>Engineering</span><span class='tag'>Scaling</span>" \
  -v FOOTER="Originally published on our engineering blog"
```

**News Article:**
```bash
scripts/from_template.sh -t news-article \
  -v TITLE="Tech Giants Report Record Earnings" \
  -v SECTION="Business" \
  -v DECK="Q4 results exceed analyst expectations across the board" \
  -v AUTHOR="Jane Smith" \
  -v LOCATION="San Francisco" \
  -v DATE="February 4, 2026" \
  -v TIME="3:45 PM EST" \
  -v LEAD="Major technology companies reported their strongest quarter..." \
  -v CONTENT="<p>Article body...</p><h2>Subhead</h2><p>More content...</p>" \
  -v RELATED="<li><a href='#'>Related Article 1</a></li><li><a href='#'>Related Article 2</a></li>" \
  -v TAGS="<span class='tag'>Tech</span><span class='tag'>Earnings</span>"
```

### Template Variables

Variables use `{{VARIABLE_NAME}}` syntax. Conditional sections use `{{#VAR}}content{{/VAR}}` - content only appears if variable is set.

Run `scripts/from_template.sh -t <template> --show` to see all variables for a template.

### Custom Output

By default, templates create a new artifact. To output to a specific file:

```bash
scripts/from_template.sh -t blog \
  -v TITLE="My Post" \
  -o /path/to/output.html
```

## When share.sh Fails

If share.sh exits with an error or doesn't show "Verified working":

1. **DO NOT send any link to the user**
2. Check the error message for the cause
3. Common issues:
   - `cloudflared not found` - Install cloudflared
   - `Failed to establish tunnel` - Network issue, try again
   - `Could not verify URL` - Tunnel didn't stabilize, try again
   - `Artifact failed validation` - Fix design violations in your HTML

4. Fix the issue and run share.sh again
5. Only send the link after seeing "Verified working"

**Never guess or construct a URL yourself. Never send a partial or cached URL.**

---

## Pre-Send Checklist

Before sending ANY link to a user, verify:

- [ ] I used create_artifact.sh (not a random temp directory)
- [ ] There is a hero image of the subject, and images at the steps that need one
- [ ] Every `<img>` uses `data-src` plus the key script, and I curled one to confirm a 200
- [ ] I loaded the live URL at phone width and looked at it
- [ ] I ran share.sh and it completed successfully
- [ ] I saw "Verified working" in the output
- [ ] The URL I'm sending is EXACTLY from the share.sh output
- [ ] I did NOT construct or modify the URL myself
- [ ] I did NOT send any link before share.sh finished

If any checkbox is unchecked, DO NOT send the link.

---

## Example Use Cases

**Static Content:**
- Research reports and documents
- Blog posts and articles
- File download pages
- Portfolios and galleries

**Interactive Applications:**
- Dashboards with live data
- Forms and surveys
- Calculators and tools
- Data visualizations

**Games (Single Player):**
- Wordle clones and word games
- Puzzle games (sliding tiles, matching)
- Quiz games
- Canvas-based arcade games

**Games (Multiplayer):**
- Turn-based games (tic-tac-toe, chess, card games)
- Real-time games with WebSockets
- Peer-to-peer games with PeerJS
- Party games with shared screens

**Multiplayer Architecture:**
The share URL becomes the game room. First visitor is host, others join as players.
```javascript
// Parse or create room ID from URL
const roomId = new URLSearchParams(location.search).get('room') || crypto.randomUUID().slice(0,8);
window.history.replaceState({}, '', `?room=${roomId}`);
// Share this URL to invite players
```

See DESIGN.md for implementation patterns including WebSockets, PeerJS, game loops, and state management.

## Cost

$0 - Cloudflare Quick Tunnels are free, no account needed.

## Uploading a photo from a page

`POST /upload?key=<key>&name=<slug>&recipe=<id>&step=<n>&profile=<who>` with the
raw image bytes as the body. Added 2026-08-16 for kitchen plate photos.

- 8 MB cap, and the file type is decided by **magic bytes**, not the
  Content-Type header, so a page cannot talk the server into writing arbitrary
  bytes. Non-images get a 415.
- The server writes to `img/upload/<sanitised>-<timestamp>.<ext>` and NOTHING
  else. The name is rebuilt from `[A-Za-z0-9_-]` so there is nothing to traverse
  with, and the endpoint never decides what a photo means.
- It then appends a normal `{"kind":"photo","file":...}` line to
  `_callbacks.jsonl`, so whoever owns the artifact picks it up on the next poll
  and moves the file where it belongs.
- Bytes go here rather than base64 inside `/callback` because `/callback` caps
  the body at 64 KB and truncates every string value to 2000 chars, and because
  the callback log is re-parsed on every poll.

Restarting a running server to pick this up keeps its URL: same port, with
`INSTANT_SHARE_TOKEN` and `INSTANT_SHARE_ARTIFACT_ID` set to the existing
values. The cloudflared process is untouched, so the tunnel survives.
