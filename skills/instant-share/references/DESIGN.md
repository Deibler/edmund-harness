# Design Guidelines for Artifacts

These guidelines are MANDATORY. All artifacts must follow these rules.

---

## READ THIS FIRST - CREATIVE PHILOSOPHY

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

### Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

### Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

**Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.**

---

## THE AI SLOP PROBLEM

The internet is now flooded with AI-generated interfaces that all look the same. Before you build anything, check if you're falling into these patterns:

### Instant Red Flags (3+ of these = start over)

- Dark theme with blue accent (#2563eb on #0a0a0a)
- Three cards in a row with identical structure and "View details →"
- Generic headline: "The modern X for Y" / "AI-powered platform for Z"
- Unicode symbols as icons (◫ ◧ ▤ ◆ ●)
- Dashed or gradient borders on cards
- "Trusted by 10K+ users" with no actual company names
- Big impressive numbers with no context
- Everything is a rounded card (border-radius: 12px) with subtle shadow
- Massive empty space because there's nothing real to show
- "Welcome to [Product]" / "Manage your products and organizations"

### Why This Matters

Users now recognize AI-generated design instantly. It signals:
- "This was made in 5 minutes with a prompt"
- "Nobody actually designed this"
- "The product probably doesn't work either"

### The Fix: Specificity and Opinion

**Copy with opinion (not marketing speak):**
```
BAD:  "The modern deployment platform for teams"
GOOD: "Deploy without the ceremony"

BAD:  "Manage your products and organizations"
GOOD: "We got tired of tools that feel like filing taxes"

BAD:  "Fast and reliable"
GOOD: "Average rollback time: 1.2 seconds"
```

**Real names, not placeholders:**
```
BAD:  "Trusted by 10,000+ teams worldwide"
GOOD: "Lattice, Ramp, Mercury, Watershed, Retool"

BAD:  "JD, CTO at TechCo"
GOOD: "Sam Chen, Head of Engineering at Lattice"
```

**Show, don't describe:**
```
BAD:  Six feature cards describing what the product does
GOOD: One screenshot of the actual interface with real data

BAD:  "Real-time logs with powerful search"
GOOD: A mock log viewer showing actual log entries
```

### Study These (They Don't Feel AI-Generated)

- **Linear.app** - Bold typography, opinionated copy, purposeful animation
- **Stripe.com** - Deep technical detail, real code examples, asymmetric layouts
- **Vercel.com** - Minimal, data-forward, text-based navigation
- **Notion.so** - Playful illustrations, personality in every interaction
- **Arc.net** - Unconventional layout, editorial magazine aesthetic

### The Test

Show your artifact to someone and ask: "Does this look like a template?"

If they hesitate, iterate until it doesn't.

---

## BANNED - NEVER USE

The following are strictly prohibited in ALL artifacts:

### Never Use Emojis
- No emojis anywhere in the UI
- No emoji in headings, buttons, status messages, or content
- Use text labels or custom icons only

### Never Use Purple
- No purple colors whatsoever
- Banned hex codes include: #800080, #663399, #9b59b6, #8e44ad, #9c27b0, #7b1fa2, #6a1b9a, #4a148c
- No violet, lavender, magenta, or any purple-adjacent colors

### Never Use Gradients
- No linear-gradient()
- No radial-gradient()
- No conic-gradient()
- Solid colors only

### Never Use "AI Slop" Aesthetics
These patterns are immediately recognizable as low-effort AI-generated design:
- Teal + purple color combinations
- Dark blue gradient backgrounds
- Floating geometric shapes
- Glowing orbs or particles
- Neon glow effects
- "Futuristic" dashboard aesthetics with glassmorphism
- Overused fonts: Inter, Roboto, Arial, system-ui defaults
- Cookie-cutter layouts that lack context-specific character

---

## CREATIVE FREEDOM - DESIGN WITH INTENTION

Beyond the banned elements above, you have creative freedom. Make bold, intentional choices.

### Design Thinking

Before coding, commit to an aesthetic direction:

1. **Purpose**: What problem does this interface solve? Who uses it?
2. **Tone**: Pick a direction - brutally minimal, maximalist, retro-futuristic, organic/natural, luxury/refined, playful, editorial/magazine, brutalist/raw, art deco, soft/pastel, industrial/utilitarian
3. **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

CRITICAL: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

### Typography

Choose fonts that are beautiful, unique, and interesting:
- Avoid generic fonts (Arial, Inter, Roboto, system-ui)
- Opt for distinctive choices that elevate the design
- Pair a distinctive display font with a refined body font
- Consider: Space Grotesk, Playfair Display, Instrument Serif, DM Sans, Syne, Outfit, Plus Jakarta Sans, Fraunces, Libre Baskerville

Load custom fonts via Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
```

### Color & Theme

Commit to a cohesive palette:
- Use CSS variables for consistency
- Dominant colors with sharp accents outperform timid, evenly-distributed palettes
- Light OR dark themes - both are valid, vary based on context
- One or two accent colors maximum

Example palettes (not exhaustive - create your own):
```css
/* Warm editorial */
--bg: #FAF7F2;
--text: #1A1A1A;
--accent: #C45B28;

/* Dark refined */
--bg: #0F0F0F;
--text: #E8E8E8;
--accent: #3B82F6;

/* Soft pastel */
--bg: #FDF4F5;
--text: #2D2D2D;
--accent: #E07A5F;

/* Industrial */
--bg: #1C1C1C;
--text: #D4D4D4;
--accent: #F59E0B;
```

### Motion & Animation

Use animations for delight and feedback:
- Prioritize CSS-only solutions
- Focus on high-impact moments: page load reveals, staggered animations
- Use animation-delay for orchestrated sequences
- Scroll-triggered effects and hover states that surprise
- Subtle micro-interactions on buttons and links

```css
/* Example: staggered fade-in */
.item {
  opacity: 0;
  transform: translateY(20px);
  animation: fadeUp 0.6s ease forwards;
}
.item:nth-child(1) { animation-delay: 0.1s; }
.item:nth-child(2) { animation-delay: 0.2s; }
.item:nth-child(3) { animation-delay: 0.3s; }

@keyframes fadeUp {
  to { opacity: 1; transform: translateY(0); }
}
```

### Spatial Composition

Create visual interest through layout:
- Unexpected layouts, asymmetry, overlap
- Grid-breaking elements
- Generous negative space OR controlled density
- Diagonal flow when appropriate
- Max content width: adjust based on content type (600-1200px)

### Backgrounds & Visual Details

Create atmosphere and depth:
- Noise textures, geometric patterns
- Layered transparencies, dramatic shadows
- Decorative borders, custom cursors
- Grain overlays for texture
- Solid colors with texture > plain white

```css
/* Subtle noise texture */
background: #FAF7F2 url("data:image/svg+xml,...") repeat;

/* Dramatic shadow */
box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
```

### React & Modern Frameworks

You may use React, Vue, or other frameworks when appropriate:
- Include framework via CDN for simple artifacts
- Use component-based architecture for complex UIs
- Motion libraries (Framer Motion, GSAP) are encouraged
- Ensure the artifact is self-contained (single HTML file or proper build)

React via CDN example:
```html
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel">
  // Your React code here
</script>
```

### Interactive Applications & Games

Build sophisticated interactive experiences:

**State Management:**
```jsx
// React hooks for complex state
const [gameState, setGameState] = useState({ players: [], turn: 0 });
const [socket, setSocket] = useState(null);

// useReducer for game logic
const [state, dispatch] = useReducer(gameReducer, initialState);
```

**Animation Libraries:**
```html
<!-- Framer Motion for React -->
<script src="https://unpkg.com/framer-motion@10/dist/framer-motion.js"></script>

<!-- GSAP for advanced animations -->
<script src="https://unpkg.com/gsap@3/dist/gsap.min.js"></script>

<!-- Three.js for 3D -->
<script src="https://unpkg.com/three@0.160/build/three.min.js"></script>
```

**Game Development Patterns:**
- Canvas API for 2D games
- requestAnimationFrame for game loops
- Keyboard/touch input handlers
- Collision detection
- Particle systems
- Sound effects via Web Audio API

```javascript
// Game loop pattern
let lastTime = 0;
function gameLoop(timestamp) {
  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;

  update(deltaTime);
  render();

  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
```

### Multiplayer & Real-Time Features

For multiplayer games and real-time collaboration:

**WebSocket Connections:**
```javascript
// Connect to game server
const ws = new WebSocket('wss://your-game-server.com');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  handleGameUpdate(data);
};

// Send player actions
function sendAction(action) {
  ws.send(JSON.stringify({ type: 'action', payload: action }));
}
```

**Peer-to-Peer with PeerJS:**
```html
<script src="https://unpkg.com/peerjs@1/dist/peerjs.min.js"></script>
<script>
  const peer = new Peer(); // Auto-generated ID

  peer.on('open', (id) => {
    console.log('My peer ID:', id);
    // Share this ID with other players
  });

  // Host a game
  peer.on('connection', (conn) => {
    conn.on('data', (data) => handlePlayerData(data));
  });

  // Join a game
  function joinGame(hostId) {
    const conn = peer.connect(hostId);
    conn.on('open', () => conn.send({ type: 'join', name: playerName }));
  }
</script>
```

**Shared State Patterns:**
```javascript
// Room-based multiplayer
const gameRoom = {
  id: generateRoomId(),
  players: [],
  state: initialGameState,

  broadcast(message) {
    this.players.forEach(p => p.conn.send(message));
  },

  sync() {
    this.broadcast({ type: 'sync', state: this.state });
  }
};

// Turn-based game flow
function handleTurn(playerId, action) {
  if (gameState.currentPlayer !== playerId) return;

  applyAction(action);
  gameState.currentPlayer = getNextPlayer();
  broadcastState();
}
```

**Shareable Game Links:**
When creating multiplayer artifacts, the share URL becomes the game room:
- Players share the artifact URL to invite others
- Use URL hash or query params for room IDs: `?room=ABC123`
- First visitor becomes host, others join as players

```javascript
// Parse room from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || generateRoomId();

// Update URL with room ID for sharing
if (!urlParams.get('room')) {
  window.history.replaceState({}, '', `?room=${roomId}`);
}
```

### Sophisticated Implementation Patterns

**Local Storage for Persistence:**
```javascript
// Save game state
function saveGame() {
  localStorage.setItem('gameState', JSON.stringify(gameState));
}

// Load game state
function loadGame() {
  const saved = localStorage.getItem('gameState');
  return saved ? JSON.parse(saved) : null;
}
```

**Service Workers for Offline:**
```javascript
// Register service worker for offline play
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```

**Audio & Sound Effects:**
```javascript
const audioContext = new AudioContext();

async function playSound(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

// Or simple HTML5 audio
const sfx = {
  click: new Audio('data:audio/wav;base64,...'),
  win: new Audio('data:audio/wav;base64,...')
};
```

**Responsive Game Canvas:**
```javascript
function resizeCanvas() {
  const container = document.getElementById('game-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
```

---

## MINIMUM REQUIREMENTS

Every artifact MUST have:

- [ ] Mobile viewport meta tag: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- [ ] A hero image of the subject, plus images through the body (see the Images section of SKILL.md). Text-only pages do not ship.
- [ ] Images referenced with `data-src` + the key script, or they 403
- [ ] Readable text (sufficient contrast)
- [ ] No emojis
- [ ] No purple colors
- [ ] No gradients
- [ ] Either `{{ADMIN_URL}}` placeholder OR `</body>` tag for admin link injection
- [ ] Professional, intentional appearance

---

## CHECKLIST BEFORE SHARING

Before running share.sh, verify:

- [ ] Committed to a clear aesthetic direction
- [ ] Typography is distinctive (not Arial/Inter/Roboto)
- [ ] Color palette is cohesive
- [ ] No banned elements (emojis, purple, gradients, AI slop)
- [ ] Mobile-responsive
- [ ] Animations enhance rather than distract
- [ ] Has `</body>` tag for admin link injection
- [ ] Looks intentionally designed, not generic

---

## WHY THESE RULES?

1. **No Emojis/Purple/Gradients** - These are markers of generic AI output
2. **Creative Freedom** - Distinctive design signals quality and care
3. **Intentionality** - Bold choices (any direction) beat safe mediocrity
4. **Accessibility** - High contrast, readable fonts help everyone
5. **Trust** - Professional design builds credibility

When in doubt: be bold. A striking dark theme with dramatic typography is better than a safe white page with system fonts.
