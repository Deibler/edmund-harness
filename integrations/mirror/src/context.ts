import type { Config } from "../../../src/config/config.ts";
import { mirrorConfig } from "../config.ts";
import { summarizeContent } from "./protocol.ts";
import { MirrorStore } from "./store.ts";

export { isMirrorSession } from "../../../src/sessions/key.ts";

/**
 * Channel-specific guidance only. Edmund's persona, memory, tools, safety,
 * recovery, and task behavior come from the same system prompt as iMessage.
 */
export function mirrorEnvelopeBlock(config: Config): string {
  let inventory = "(unavailable)";
  let page = "home";
  let revision = 0;
  try {
    const store = new MirrorStore(config.paths.data_dir);
    try {
      const snapshot = store.snapshot();
      page = snapshot.page;
      revision = snapshot.revision;
      inventory =
        snapshot.contents.length === 0
          ? "(none)"
          : snapshot.contents.map((content) => `- ${summarizeContent(content)}`).join("\n");
    } finally {
      store.close();
    }
  } catch {
    // Presentation inventory is useful context, never a reason to block a turn.
  }

  return [
    "",
    "[MIRROR CHANNEL — EDMUND ON GLASS]",
    "This is a second Edmund channel. The user spoke the inbound message aloud.",
    "Use the same judgment, memory, tools, safety rules, and ability you use in iMessage.",
    "",
    "CALLING MIRROR TOOLS:",
    "- Every Mirror tool must use its exact fully qualified name beginning",
    "  `mcp__edmund-harness__`. Bare names are descriptions, not callable aliases.",
    "- For example, call `mcp__edmund-harness__render_mirror_content`, never",
    "  bare `render_mirror_content`; Claude Code rejects the bare name.",
    "- `mcp__edmund-harness__Close` is always available in this channel. Call it",
    "  when the conversation is complete or the user asks to dismiss the chat UI,",
    "  then finish the turn with [SILENT]. It detaches the UI without cancelling",
    "  background work.",
    "",
    "DELIVERY:",
    "- Your final reply is automatically shown on the mirror. During a live voice",
    "  conversation it is also spoken. Do not call a tool just to duplicate it.",
    "- For a long operation, a brief `mcp__edmund-harness__speak_on_mirror`",
    "  acknowledgment is useful,",
    "  then do the work and give the actual result. Keep speech natural and short.",
    "- If `mcp__edmund-harness__speak_on_mirror` already conveyed the entire",
    "  answer, finish with [SILENT].",
    "- Automated, cron, recovery, mission, and proactive turns render silently.",
    "  Never make the mirror speak unless a user recently opened a voice volley.",
    "- Files/images/video/audio sent with",
    "  `mcp__edmund-harness__send_attachment` render on the glass.",
    "",
    "PRESENTATION:",
    "- The display accepts typed, validated components — never HTML, CSS, SVG,",
    "  scripts, iframes, or markup. Use",
    "  `mcp__edmund-harness__render_mirror_content`.",
    "- Components: text_block, list_card, image_card, image_gallery, video,",
    "  audio, link_card, file_card, progress, stats, table, agenda, tracker,",
    "  recipe, chart, menu, story_list, weather, clock, date, status.",
    "- story_list: use for ANY headlines or news. Send `stories` with",
    "  {headline, source, age, image}. The first one is drawn as the lead — it",
    "  gets the art and the large type — so put the most important story first",
    "  and pass an `image` on it when you have one. Never flatten headlines into",
    "  list_card strings: the source has to be a separate field to be set in",
    "  brass, and a string cannot carry one.",
    "- menu: use for any priced list (restaurant, cafe, bar). Send sections with",
    "  {name, description, price} per item and set `highlight` to the dish that",
    "  was asked about. Never flatten a menu into list_card strings — the price",
    "  column is the whole point and a string cannot be aligned.",
    "- widget = glanceable and coexists in a region; page = one focused full-screen",
    "  subject; slideshow = a bounded rotating gallery.",
    "- ZONE WIDTH: the six corner zones (top_left/center/right and",
    "  bottom_left/center/right) share a row, so each is a THIRD of the glass —",
    "  about sixteen characters a line. They are for a time, a temperature, a",
    "  status: nothing with a sentence in it. Anything that reads as prose",
    "  belongs in upper_third or lower_third, which run the full width.",
    "  You pick top or bottom; the display corrects the width if you get it",
    "  wrong, so a headline is never rendered seven characters to a line.",
    "- Keep ordinary ambient information at the edges so the reflection stays",
    "  usable.",
    "- top_left holds the protected clock (which draws the date beneath it).",
    "  Put standing world data — weather, air quality, tides — in top_right so",
    "  the two top corners read as one ambient band.",
    "- weather: pass `icon` (sun/cloud/rain/snow/storm/fog/wind, or a plain",
    "  forecast phrase — it is normalized). The glyph replaces the condition",
    "  text on the glass, so a card without an icon reads worse.",
    "",
    "LIFETIME (mechanics; the judgement is in your venue prompt):",
    '- `lifespan: { mode: "ephemeral", ttl_seconds: N }` — N is 15..86400.',
    `  Bare \`ephemeral\` takes the ${mirrorConfig(config).default_ttl_seconds}s default. Pick a number instead:`,
    "  size the life to the activity, not to the default.",
    '- `lifespan: "persistent"` only when asked to keep something. It has no',
    "  clock and sits under the transient layer, surfacing as that drains away.",
    "- To chain: give each part its own item or update the widget as parts",
    "  finish, so it shrinks toward its own end.",
    "",
    "- Give stable IDs to content you will update. Inspect",
    "  `mcp__edmund-harness__list_mirror_content` before redesigning.",
    "- system:clock is the one protected baseline fixture and it draws the date",
    "  itself. The store enforces this;",
    "  `mcp__edmund-harness__reset_mirror_baseline` safely removes custom content.",
    "- For structured trackers, store facts with",
    "  `mcp__edmund-harness__mirror_widget_state_set` and",
    "  `mcp__edmund-harness__mirror_widget_state_get`, then render a tracker",
    "  component. General human memory still belongs in Edmund's normal",
    "  person/self memory tools.",
    "- Existing reminder, cron, trigger, mission, agent, research, generation,",
    "  browser, and web tools all work here. Render their useful result.",
    "",
    `Current presentation revision: ${revision}`,
    `Current page: ${page}`,
    "Current content:",
    inventory,
  ].join("\n");
}
