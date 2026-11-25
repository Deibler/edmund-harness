import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTBOX_ROWS, MirrorStore } from "../integrations/mirror/src/store.ts";

const dirs: string[] = [];

function makeStore(): MirrorStore {
  const dir = mkdtempSync(join(tmpdir(), "edmund-mirror-store-"));
  dirs.push(dir);
  return new MirrorStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MirrorStore v2", () => {
  test("seeds one protected clock fixture that also carries the date", () => {
    const store = makeStore();
    try {
      const snapshot = store.snapshot();
      expect(snapshot.revision).toBe(0);
      // The date is not a second fixture in the opposite corner any more —
      // it renders inside the clock so the two read as one glance.
      expect(snapshot.contents.map((item) => item.id)).toEqual(["system:clock"]);
      const clock = snapshot.contents[0]!;
      expect(clock.protected).toBe(true);
      expect(clock.component).toBe("clock");
      expect((clock.props as { showDate?: boolean }).showDate).toBe(true);
      expect(store.listReadyOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("retires a legacy system:date fixture into the clock on reopen", () => {
    // An installed mirror already holds a protected `system:date` in the
    // opposite corner, and seedBaseline only inserts what is missing — so
    // without the migration an upgrade would show the date twice.
    const dir = mkdtempSync(join(tmpdir(), "edmund-mirror-store-"));
    dirs.push(dir);

    const before = new MirrorStore(dir);
    try {
      before.upsertContent({
        id: "system:date",
        page: "*",
        zone: "top_right",
        component: "date",
        props: { timezone: "local", format: "long" },
        lifespan: "persistent",
        expiresAtMs: null,
        protected: true,
      });
      before.upsertContent({
        id: "system:clock",
        page: "*",
        zone: "top_left",
        component: "clock",
        props: { timezone: "local", showSeconds: false, twelveHour: true, showDate: false },
        lifespan: "persistent",
        expiresAtMs: null,
        protected: true,
      });
      expect(before.snapshot().contents.map((item) => item.id)).toContain("system:date");
    } finally {
      before.close();
    }

    const after = new MirrorStore(dir);
    try {
      const ids = after.snapshot().contents.map((item) => item.id);
      expect(ids).not.toContain("system:date");
      expect(ids).toContain("system:clock");
      const clock = after.getContent("system:clock")!;
      expect((clock.props as { showDate?: boolean }).showDate).toBe(true);
    } finally {
      after.close();
    }
  });

  test("leaves a model-placed date widget alone", () => {
    // Only the protected fixture is retired. An ordinary `date` the model
    // put somewhere is content, not baseline.
    const dir = mkdtempSync(join(tmpdir(), "edmund-mirror-store-"));
    dirs.push(dir);

    const before = new MirrorStore(dir);
    try {
      before.upsertContent({
        id: "date:kitchen",
        zone: "bottom_left",
        component: "date",
        props: { timezone: "local", format: "compact" },
        lifespan: "persistent",
        expiresAtMs: null,
      });
    } finally {
      before.close();
    }

    const after = new MirrorStore(dir);
    try {
      expect(after.snapshot().contents.map((item) => item.id)).toContain("date:kitchen");
    } finally {
      after.close();
    }
  });

  test("commits content and a stable reliable outbox row together", () => {
    const store = makeStore();
    try {
      const content = store.upsertContent({
        id: "brief:today",
        page: "home",
        zone: "lower_third",
        component: "list_card",
        props: { title: "Today", items: ["Dentist at 2", "Rain after 5"] },
        lifespan: "ephemeral",
        expiresAtMs: Date.now() + 60_000,
      });
      expect(content.revision).toBe(1);
      const queued = store.listReadyOutbox();
      expect(queued).toHaveLength(1);
      expect(JSON.parse(queued[0]!.payload)).toMatchObject({
        type: "content_upsert",
        revision: 1,
        content: { id: "brief:today" },
      });

      store.noteOutboxAttempt(queued[0]!.messageId, 1_000);
      expect(store.listReadyOutbox(1_500, 1_000)).toHaveLength(0);
      expect(store.listReadyOutbox(2_001, 1_000)).toHaveLength(1);
      expect(store.acknowledgeOutbox(queued[0]!.messageId)).toBe(true);
      expect(store.listReadyOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("removes expired content through revisioned reliable deltas", () => {
    const store = makeStore();
    try {
      store.upsertContent({
        id: "photo:temporary",
        zone: "upper_third",
        component: "image_card",
        props: {
          src: "http://127.0.0.1:8789/asset/photo.webp",
          alt: "A dog",
        },
        lifespan: "ephemeral",
        expiresAtMs: 10,
      });
      for (const row of store.listReadyOutbox()) store.acknowledgeOutbox(row.messageId);
      expect(store.pruneExpired(11)).toEqual(["photo:temporary"]);
      expect(store.getContent("photo:temporary")).toBeNull();
      expect(JSON.parse(store.listReadyOutbox()[0]!.payload)).toMatchObject({
        type: "content_remove",
        revision: 2,
        contentId: "photo:temporary",
      });
    } finally {
      store.close();
    }
  });

  test("protected baseline is structural, not prompt-only", () => {
    const store = makeStore();
    try {
      expect(() => store.removeContent("system:clock")).toThrow("protected baseline");
      expect(() =>
        store.upsertContent({
          id: "system:clock",
          zone: "bottom_bar",
          component: "clock",
          props: { timezone: "local", showSeconds: true, twelveHour: false },
          lifespan: "persistent",
          expiresAtMs: null,
        }),
      ).toThrow("protected baseline");
    } finally {
      store.close();
    }
  });

  test("baseline reset is one convergent snapshot and preserves fixtures", () => {
    const store = makeStore();
    try {
      store.upsertContent({
        id: "plants",
        zone: "bottom_left",
        component: "tracker",
        props: { title: "Plants", label: "Fern", status: "Water today" },
        lifespan: "persistent",
        expiresAtMs: null,
      });
      for (const row of store.listReadyOutbox()) store.acknowledgeOutbox(row.messageId);
      store.setPage("kitchen");
      for (const row of store.listReadyOutbox()) store.acknowledgeOutbox(row.messageId);

      const result = store.resetToBaseline("test");
      expect(result.removed).toEqual(["plants"]);
      expect(store.snapshot().page).toBe("home");
      expect(store.snapshot().contents.map((item) => item.id)).toEqual(["system:clock"]);
      expect(JSON.parse(store.listReadyOutbox()[0]!.payload).type).toBe("snapshot");
    } finally {
      store.close();
    }
  });

  test("persists rotation through a convergent snapshot", () => {
    const store = makeStore();
    try {
      expect(store.snapshot().rotation).toBe(0);
      const revision = store.setRotation(90, "test");
      expect(revision).toBe(1);
      expect(store.snapshot().rotation).toBe(90);
      expect(JSON.parse(store.listReadyOutbox()[0]!.payload)).toMatchObject({
        type: "snapshot",
        revision: 1,
        rotation: 90,
      });
      expect(store.listAudit(1)[0]).toMatchObject({
        revision: 1,
        action: "rotation.set",
        reason: "test",
      });
    } finally {
      store.close();
    }

    const reopened = new MirrorStore(dirs.at(-1)!);
    try {
      expect(reopened.snapshot().rotation).toBe(90);
    } finally {
      reopened.close();
    }
  });

  test("widget state round-trips JSON independently of presentation", () => {
    const store = makeStore();
    try {
      store.setWidgetState("plants", "last_watered:fern", "2026-07-22T09:00:00Z", "datetime");
      expect(store.getWidgetState("plants", "last_watered:fern")).toBe("2026-07-22T09:00:00Z");
    } finally {
      store.close();
    }
  });

  test("expires transient commands instead of replaying stale UI state", () => {
    const store = makeStore();
    try {
      store.enqueueCommand(
        {
          v: 2,
          id: "overlay:stale",
          type: "overlay_set",
          overlay: { phase: "thinking" },
        },
        1_000,
      );
      const queued = store.listReadyOutbox(Date.now());
      expect(queued).toHaveLength(1);
      expect(queued[0]!.expiresAtMs).not.toBeNull();
      expect(store.listReadyOutbox(queued[0]!.expiresAtMs!)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  // The Pi was off the network for nine days. State deltas never expire, so
  // they filled the outbox, and from then on every write threw: the tools, the
  // refresh scripts, and the expiry sweep on its timer.
  test("a Pi that stays away cannot fill the outbox with state deltas", () => {
    const store = makeStore();
    try {
      const writes = MAX_OUTBOX_ROWS + 5;
      for (let i = 0; i < writes; i++) store.upsertContent(note(`${i}`));

      const queued = drainOutbox(store);
      expect(queued).toHaveLength(MAX_OUTBOX_ROWS);
      // The newest state survives; what gave way was the oldest, which the
      // snapshot a reconnect begins with replaces anyway.
      const revisions = queued.map((frame) => frame.revision as number).sort((a, b) => a - b);
      expect(revisions.at(-1)).toBe(writes);
      expect(revisions[0]).toBe(writes - MAX_OUTBOX_ROWS + 1);
      expect(store.getContent("note")?.props).toMatchObject({ text: `${writes - 1}` });
    } finally {
      store.close();
    }
  });

  test("expired content is still removed while the outbox is full", () => {
    const store = makeStore();
    try {
      store.upsertContent({ ...note("stale"), id: "note:expiring", expiresAtMs: 10 });
      for (let i = 0; i < MAX_OUTBOX_ROWS; i++) store.upsertContent(note(`${i}`));

      expect(store.pruneExpired(11)).toEqual(["note:expiring"]);
      expect(store.getContent("note:expiring")).toBeNull();
      const queued = drainOutbox(store);
      expect(queued).toHaveLength(MAX_OUTBOX_ROWS);
      expect(
        queued.filter(
          (frame) => frame.type === "content_remove" && frame.contentId === "note:expiring",
        ),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a full outbox gives up state deltas, never a pending command", () => {
    const store = makeStore();
    try {
      store.enqueueCommand(
        { v: 2, id: "overlay:pending", type: "overlay_set", overlay: { phase: "thinking" } },
        60_000,
      );
      for (let i = 0; i < MAX_OUTBOX_ROWS + 5; i++) store.upsertContent(note(`${i}`));

      const queued = drainOutbox(store);
      expect(queued).toHaveLength(MAX_OUTBOX_ROWS);
      expect(queued.filter((frame) => frame.id === "overlay:pending")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("an outbox full of commands still refuses another", () => {
    const store = makeStore();
    try {
      const command = (i: number) =>
        ({
          v: 2,
          id: `overlay:${i}`,
          type: "overlay_set",
          overlay: { phase: "thinking" },
        }) as const;
      for (let i = 0; i < MAX_OUTBOX_ROWS; i++) store.enqueueCommand(command(i), 60_000);

      expect(() => store.enqueueCommand(command(MAX_OUTBOX_ROWS), 60_000)).toThrow(/full/);
      expect(() => store.upsertContent(note("blocked"))).toThrow(/full/);
      expect(store.getContent("note")).toBeNull();
    } finally {
      store.close();
    }
  });
});

function note(text: string) {
  return {
    id: "note",
    zone: "lower_third",
    component: "text_block",
    props: { text },
    lifespan: "session",
    expiresAtMs: null,
  } as const;
}

/** Every queued frame, oldest first, acknowledged as it is read. */
function drainOutbox(store: MirrorStore): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (;;) {
    const rows = store.listReadyOutbox(Date.now(), 0, 128);
    if (rows.length === 0) return frames;
    for (const row of rows) {
      frames.push(JSON.parse(row.payload));
      store.acknowledgeOutbox(row.messageId);
    }
  }
}
