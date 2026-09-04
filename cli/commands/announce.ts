/**
 * `edmund announce add --title T --body "..." [--link /skills] [...]`
 * `edmund announce list`                — the feature log
 * `edmund announce retire <id>`         — stop offering one
 * `edmund announce status [<id>]`       — who has heard it, and who is eligible
 * `edmund announce who`                 — the eligible audience, right now
 *
 * The feature log is the operator-facing half of announcements. Nothing here
 * sends anything: adding an entry makes it AVAILABLE to be worked into a
 * conversation with someone who talks to Edmund often enough, the next time
 * they write in.
 */

import { activeDays, tenureDays } from "../../src/announce/eligibility.ts";
import { PORTAL_TABS, normalizeLink } from "../../src/announce/links.ts";
import { AnnouncementStore } from "../../src/announce/store.ts";
import { PERSONA_DIR } from "../../src/claude/persona.ts";
import { loadConfig } from "../../src/config/config.ts";
import { ChatDb } from "../../src/imessage/db.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import { chatIdFromKey, isDmSession, normalizeHandle } from "../../src/sessions/key.ts";
import { StateStore } from "../../src/sessions/store.ts";
import { describeLeaks, findLeaks } from "../../src/skills/privacy.ts";
import type { Parsed } from "../args.ts";
import { color, fail, info, ok, print, section, table } from "../ui.ts";

const USAGE = `${color.bold("edmund announce")} — tell regulars about a new capability

${color.bold("Usage:")}
  edmund announce add --title "Skills browser" --body "..." [--link /skills]
                      [--min-active-days N] [--starts ISO] [--expires ISO]
  edmund announce list
  edmund announce retire <id>
  edmund announce status [<id>]
  edmund announce who

${color.bold("Notes:")}
  --body is what Edmund conveys, in his own words, when a natural opening
  comes up in a conversation with someone who texts him regularly. It is
  never sent as its own message and never sent to a group.

  --link is a portal tab (${PORTAL_TABS.join(", ")}). Each recipient gets
  their own signed URL, and that link is how delivery is confirmed.
`;

function stores() {
  const cfg = loadConfig();
  return {
    cfg,
    store: new AnnouncementStore(cfg.paths.data_dir),
    chatDb: new ChatDb(cfg.paths.chat_db),
    contacts: new ContactBook(cfg.contacts, new AddressBook()),
  };
}

export async function announceCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    print(USAGE);
    return;
  }
  switch (sub) {
    case "add":
      return add(p);
    case "list":
    case "ls":
      return list();
    case "retire":
      return retire(p.positional[1]);
    case "status":
      return status(p.positional[1]);
    case "who":
      return who();
    default:
      fail(`unknown announce subcommand: ${sub}`);
      print(USAGE);
      process.exit(2);
  }
}

function str(p: Parsed, name: string): string | null {
  const v = p.flags[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function add(p: Parsed): void {
  const title = str(p, "title");
  const body = str(p, "body");
  if (!title || !body) {
    fail("usage: edmund announce add --title <title> --body <what Edmund should say>");
    process.exit(2);
  }
  const { store } = stores();
  const startsRaw = str(p, "starts");
  const expiresRaw = str(p, "expires");
  const starts = startsRaw ? Date.parse(startsRaw) : Date.now();
  const expires = expiresRaw ? Date.parse(expiresRaw) : null;
  if (Number.isNaN(starts) || (expires !== null && Number.isNaN(expires))) {
    fail("--starts / --expires must be ISO dates");
    process.exit(2);
  }
  // Validate the link before anything is written. A portal tab is a hash
  // anchor, and a path like "/skills" answers 200 with the WRONG page — so a
  // typo here would ship a dead link to people who trust the sender.
  const link = normalizeLink(str(p, "link"));
  if (!link.ok) {
    fail(link.reason);
    process.exit(2);
  }

  // An announcement goes to everyone who qualifies, so it must not carry
  // anyone's name, number, email or address out of the conversation it was
  // written in. Same scanner the skills path uses, and for the same reason:
  // being careful is not a property, and this text is written by hand at a
  // moment when the author is thinking about the feature, not about privacy.
  const { contacts, cfg: cfgForScan } = stores();
  const leaks = findLeaks(`${title}\n${body}`, contacts, cfgForScan.identity.names, {
    personaDir: PERSONA_DIR,
  });
  if (leaks.length > 0) {
    fail(`that names someone: ${describeLeaks(leaks)}. Rewrite it so it reads for a stranger.`);
    process.exit(2);
  }

  const minDaysRaw = str(p, "min-active-days");
  const id = `ann_${Date.now().toString(36)}`;

  const record = store.add({
    id,
    title,
    body,
    // Default to the portal root: everyone has one, so delivery is always
    // confirmable, and the portal is where the announcement's subject lives.
    link_path: link.linkPath,
    starts_ms: starts,
    expires_ms: expires,
    min_active_days: minDaysRaw ? Number.parseInt(minDaysRaw, 10) : null,
    active: true,
  });
  store.close();
  ok(`added ${record.id} — "${record.title}"`);
  info("It will be worked into conversations with regulars from their next message.");
}

function list(): void {
  const { store } = stores();
  const all = store.list();
  const rows = all.map((a) => {
    const d = store.deliveriesOf(a.id);
    return [
      a.id,
      a.title.length > 34 ? `${a.title.slice(0, 31)}…` : a.title,
      a.active ? color.green("live") : color.dim("retired"),
      String(d.filter((x) => x.state === "delivered").length),
      String(d.filter((x) => x.state === "offered").length),
      String(d.filter((x) => x.state === "exhausted").length),
    ];
  });
  store.close();
  section("feature log");
  if (rows.length === 0) {
    info("empty — nothing has been announced.");
    return;
  }
  table(["id", "title", "state", "told", "pending", "gave up"], rows);
}

function retire(id: string | undefined): void {
  if (!id) {
    fail("usage: edmund announce retire <id>");
    process.exit(2);
  }
  const { store } = stores();
  const changed = store.setActive(id, false);
  store.close();
  if (!changed) {
    fail(`no such announcement: ${id}`);
    process.exit(1);
  }
  ok(`retired ${id} — it will not be offered again.`);
}

function status(id: string | undefined): void {
  const { store } = stores();
  const targets = id ? [store.get(id)].filter(Boolean) : store.list();
  if (targets.length === 0) {
    store.close();
    info(id ? `no such announcement: ${id}` : "nothing in the feature log.");
    return;
  }
  for (const a of targets) {
    if (!a) continue;
    section(`${a.id} — ${a.title}`);
    const rows = store
      .deliveriesOf(a.id)
      .map((d) => [
        d.session_key.replace("imessage:dm:", ""),
        d.state === "delivered"
          ? color.green("told")
          : d.state === "exhausted"
            ? color.dim("gave up")
            : color.yellow("pending"),
        String(d.offers),
        new Date(d.last_offered_ms).toISOString().slice(0, 10),
      ]);
    if (rows.length === 0) info("nobody has been offered this yet.");
    else table(["chat", "state", "chances", "last"], rows);
  }
  store.close();
}

/**
 * The audience, computed the same way the live gate computes it.
 *
 * Worth running before adding an announcement: it answers "who would actually
 * hear this?" in advance, rather than after the fact.
 */
function who(): void {
  const { cfg, store, chatDb, contacts } = stores();
  const state = new StateStore(cfg.paths.data_dir);
  const a = cfg.announcements;
  const now = Date.now();

  const rows: string[][] = [];
  for (const s of state.listSessions()) {
    if (!isDmSession(s.sessionKey)) continue;
    const handle = normalizeHandle(chatIdFromKey(s.sessionKey));
    const handles = contacts.aliasesFor(handle);
    const days = activeDays(chatDb, handles, a.window_days, now);
    const tenure = tenureDays(chatDb, handles, now);
    const eligible = days >= a.min_active_days && tenure >= a.min_tenure_days;
    rows.push([
      contacts.displayName(handle) ?? handle,
      `${days}/${a.window_days}`,
      `${tenure}d`,
      eligible ? color.green("yes") : color.dim("no"),
    ]);
  }
  state.close();
  store.close();

  rows.sort((x, y) => Number.parseInt(y[1] ?? "0", 10) - Number.parseInt(x[1] ?? "0", 10));
  section(
    `audience — needs ${a.min_active_days}+ active days in ${a.window_days}, known ${a.min_tenure_days}+ days`,
  );
  const yes = rows.filter((r) => r[3]?.includes("yes")).length;
  table(["person", "active days", "known", "eligible"], rows);
  info(`${yes} of ${rows.length} conversations would hear about a new capability.`);
}
