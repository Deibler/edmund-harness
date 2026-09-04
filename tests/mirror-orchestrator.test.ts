import { describe, expect, test } from "bun:test";
import type { MirrorBridge } from "../integrations/mirror/src/bridge.ts";
import { MirrorOrchestrator } from "../integrations/mirror/src/orchestrator.ts";
import type { MirrorStore } from "../integrations/mirror/src/store.ts";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { SessionKey } from "../src/sessions/key.ts";

/**
 * The background watch reports jobs, not bare ids. These tests are about the
 * dock and fold gate rather than the roster, so they keep naming ids and this
 * gives each one the shape the orchestrator now takes.
 */
const jobs = (...ids: string[]) =>
  ids.map((id) => ({ id, task: `work for ${id}`, spawnedAtMs: Date.now() - 60_000 }));

describe("MirrorOrchestrator channel policy", () => {
  test("routes utterances into the shared pipeline and projects a bounded conversation", async () => {
    const harness = makeHarness();
    await harness.orchestrator.onUtterance("wav", "utterance:one");
    await tick();

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.key).toBe("mirror:pi-4");
    expect(harness.enqueued[0]!.message.text).toBe("show me the weather");
    expect(harness.overlays.at(-1)).toMatchObject({
      phase: "thinking",
      messages: [
        {
          role: "user",
          text: "show me the weather",
          final: true,
        },
      ],
    });
  });

  test("holds assistant text for voice-timed captions and carries its identity into audio", async () => {
    const harness = makeHarness();
    await harness.orchestrator.onUtterance("wav", "utterance:voice");
    harness.orchestrator.onTurnStarted("turn:one");
    harness.orchestrator.onModelTextDelta("turn:one", "Here is ");
    harness.orchestrator.onModelTextDelta("turn:one", "the forecast.");
    await tick();

    expect(harness.overlays.at(-1)).toMatchObject({
      phase: "responding",
    });
    expect(
      (harness.overlays.at(-1)?.messages as Array<Record<string, unknown>>).some(
        (message) => message.role === "assistant",
      ),
    ).toBe(false);

    expect(await harness.orchestrator.deliver("Here is the forecast.", "turn:one")).toEqual({
      delivered: true,
    });
    expect(harness.audio[0]).toMatchObject({
      text: "Here is the forecast.",
      messageId: "assistant:turn:one",
    });
    // Mirrors the real sequence: turn.ts reports "delivered" once the reply is
    // queued, then playback finishing is what hands the floor back.
    await harness.orchestrator.onTurnSettled("turn:one", "delivered");
    harness.orchestrator.onAudioDone(false, harness.audio[0]!.id);
    await tick();
    expect(harness.followups).toBe(1);
  });

  test("projects automation replies durably without unsolicited audio", async () => {
    const harness = makeHarness();
    expect(await harness.orchestrator.deliver("The package arrived.")).toEqual({
      delivered: true,
    });
    expect(harness.audio).toHaveLength(0);
    expect(harness.rendered[0]).toMatchObject({
      id: "system:last-response",
      component: "text_block",
      props: { eyebrow: "Edmund", text: "The package arrived." },
      lifespan: "ephemeral",
    });
  });

  test("bye detaches the UI and speech while letting active work finish", async () => {
    const harness = makeHarness(["Start the work", "Edmund, bye"]);
    await harness.orchestrator.onUtterance("wav", "utterance:start");
    harness.orchestrator.onTurnStarted("turn:background");
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:bye");
    await tick();

    expect(harness.interruptions).toEqual([]);
    expect(harness.overlays.at(-1)).toEqual({ phase: "idle" });
    expect(
      await harness.orchestrator.deliver("Background work finished.", "turn:background"),
    ).toEqual({ delivered: false, suppressed: true });
    expect(harness.audio).toHaveLength(0);
  });

  test("Close() detaches the UI and speech while letting active work finish", async () => {
    const harness = makeHarness("Start the work");
    await harness.orchestrator.onUtterance("wav", "utterance:start");
    harness.orchestrator.onTurnStarted("turn:background");
    harness.orchestrator.closeConversation("Close() tool");
    await tick();

    expect(harness.interruptions).toEqual([]);
    expect(harness.overlays.at(-1)).toEqual({ phase: "idle" });
    expect(
      await harness.orchestrator.deliver("Background work finished.", "turn:background"),
    ).toEqual({ delivered: false, suppressed: true });
    expect(harness.audio).toHaveLength(0);
  });

  test("stop cancels queued and active work without entering the model pipeline", async () => {
    const harness = makeHarness(["Start the work", "Edmund, stop"]);
    await harness.orchestrator.onUtterance("wav", "utterance:start");
    harness.orchestrator.onTurnStarted("turn:active");
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:stop");
    await tick();

    expect(harness.cancelQueued).toBe(1);
    expect(harness.interruptions).toEqual(["mirror user said stop"]);
    expect(harness.overlays.at(-1)).toEqual({ phase: "idle" });
  });

  test("a normal interjection cancels the old turn and becomes the next user message", async () => {
    const harness = makeHarness(["Show today", "Edmund, also include tomorrow"]);
    await harness.orchestrator.onUtterance("wav", "utterance:first");
    harness.orchestrator.onTurnStarted("turn:old");
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:barge");
    await tick();

    expect(harness.interruptions).toEqual(["superseded by mirror interjection"]);
    expect(harness.enqueued.at(-1)?.message.text).toBe("also include tomorrow");
    expect(harness.overlays.at(-1)?.phase).toBe("thinking");
    const messages = harness.overlays.at(-1)?.messages as
      | Array<Record<string, unknown>>
      | undefined;
    expect(
      messages?.some(
        (message) =>
          message.role === "user" &&
          message.text === "also include tomorrow" &&
          message.final === true,
      ),
    ).toBe(true);
    await harness.orchestrator.onTurnSettled("turn:old", "interrupted");
    expect(harness.overlays.at(-1)?.phase).toBe("thinking");
  });

  test("does not mistake embedded exit language for a command", async () => {
    const harness = makeHarness("Find the song called Goodbye Yellow Brick Road");
    await harness.orchestrator.onUtterance("wav", "utterance:not-an-exit");

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.message.text).toBe(
      "Find the song called Goodbye Yellow Brick Road",
    );
  });
});

function makeHarness(transcript: string | string[] = "Hey Edmund, show me the weather") {
  const transcripts = Array.isArray(transcript) ? [...transcript] : [transcript];
  const enqueued: Array<{ key: SessionKey; message: InboundMessage }> = [];
  const overlays: Array<Record<string, unknown>> = [];
  const audio: Array<{ id: string; text?: string; messageId?: string }> = [];
  const rendered: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const interruptions: string[] = [];
  let followups = 0;
  let cancelQueued = 0;
  let resumes = 0;
  const stops: string[] = [];
  const pipeline = {
    enqueue(key: SessionKey, message: InboundMessage) {
      enqueued.push({ key, message });
    },
    cancelQueued() {
      cancelQueued += 1;
      return 1;
    },
  } as unknown as SessionPipeline;
  const bridge = {
    async setOverlay(overlay: Record<string, unknown>) {
      overlays.push(overlay);
      return { delivered: true };
    },
    async playAudio(payload: { text?: string; messageId?: string }, id: string) {
      audio.push({ id, text: payload.text, messageId: payload.messageId });
      return { delivered: true };
    },
    async requestFollowup() {
      followups += 1;
      return { delivered: true };
    },
    async resumeAudio() {
      resumes += 1;
      return { delivered: true };
    },
    async stopAudio(reason?: string) {
      stops.push(reason ?? "");
      return { delivered: true };
    },
  } as unknown as MirrorBridge;
  const store = {
    upsertContent(content: Record<string, unknown>) {
      rendered.push(content);
      return content;
    },
    // The orchestrator removes the agent roster when the last job settles. Its
    // absence here was silently swallowed by that method's catch, which is
    // exactly the shape of "the test passes and the glass keeps a stale
    // widget".
    removeContent(id: string) {
      removed.push(id);
      return true;
    },
  } as unknown as MirrorStore;
  const config = {
    mirror: {
      session_key: "mirror:pi-4",
      followup_window: true,
      default_ttl_seconds: 300,
    },
    alerts: { operator_handle: "" },
  } as Config;
  const orchestrator = new MirrorOrchestrator({
    config,
    pipeline,
    bridge,
    store,
    interruptModel: (reason) => {
      interruptions.push(reason);
      return true;
    },
    voice: {
      transcribe: async () => transcripts.shift() ?? "",
      synthesize: async () => ({ base64: "YXVkaW8=", format: "wav" }),
    },
  });
  return {
    orchestrator,
    enqueued,
    overlays,
    audio,
    rendered,
    removed,
    interruptions,
    get followups() {
      return followups;
    },
    get cancelQueued() {
      return cancelQueued;
    },
    get resumes() {
      return resumes;
    },
    stops,
  };
}

/**
 * The mirror speaks through a loudspeaker in the same room as its microphone,
 * so it can hear itself. A wake raised by its own voice used to cut the reply
 * short and then feed those words back as if the user had said them.
 */
describe("MirrorOrchestrator self-echo rejection", () => {
  async function speakThenHear(spoken: string, heard: string) {
    const harness = makeHarness(["open the conversation", heard]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver(spoken, "turn:one");
    const before = harness.enqueued.length;
    await harness.orchestrator.onUtterance("wav", "utterance:echo");
    await tick();
    return { harness, added: harness.enqueued.length - before };
  }

  test("discards an utterance that is mostly words it just spoke", async () => {
    // Taken verbatim from the live failure: Edmund read a recipe aloud and the
    // mic returned a garbled subset of it as user speech.
    const { harness, added } = await speakThenHear(
      "Then we add the tuna and just stir for a bit. Let the chocolate and fish infuse.",
      "then we add the tuna and just stir for a bit just let the chocolate and fish infuse",
    );
    expect(added).toBe(0);
    // The volley continues rather than starting a turn.
    expect(harness.resumes).toBeGreaterThan(0);
    expect(harness.interruptions).toHaveLength(0);
  });

  test("survives the word loss and reordering real room capture introduces", async () => {
    const { added } = await speakThenHear(
      "The forecast calls for clear skies through Sunday with highs near eighty.",
      "forecast calls clear skies sunday highs near eighty",
    );
    expect(added).toBe(0);
  });

  test("a genuine question is never mistaken for echo", async () => {
    const { harness, added } = await speakThenHear(
      "It is seventy two degrees and sunny in Lancaster right now.",
      "Edmund can you put the radar on the screen instead",
    );
    expect(added).toBe(1);
    expect(harness.enqueued.at(-1)?.message.text).toBe(
      "can you put the radar on the screen instead",
    );
  });

  test("short replies are never mistaken for echo", async () => {
    // "yes"/"no thanks"/"do it" would trip any overlap test by chance, and are
    // exactly what someone says during a follow-up window.
    const { added } = await speakThenHear(
      "Should I put the radar up on the screen?",
      "Edmund yes do it",
    );
    expect(added).toBe(1);
  });

  test("a confident wake model settles it without re-reading the transcript", async () => {
    // The whole point of the openWakeWord replacement. The detector already
    // decided acoustically, with a calibrated number, that the wake word was
    // spoken. Re-running the string matcher on Whisper's spelling would only
    // add a second, worse opinion — and would reject a real wake whenever the
    // name came back spelled a way nobody thought to list.
    const harness = makeHarness(["turn the kitchen lights on"]);
    harness.orchestrator.onWake({ score: 0.93, label: "edmund" });
    await harness.orchestrator.onUtterance("wav", "utterance:scored");
    await tick();

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.message.text).toBe("turn the kitchen lights on");
  });

  test("a low-confidence wake is still made to prove itself", async () => {
    const harness = makeHarness(["something the neighbours said"]);
    harness.orchestrator.onWake({ score: 0.11, label: "edmund" });
    await harness.orchestrator.onUtterance("wav", "utterance:weak");
    await tick();

    expect(harness.enqueued).toHaveLength(0);
  });

  test("an unscored detector still falls back to the transcript check", async () => {
    // The Vosk grammar fallback reports no score at all. That absence is the
    // signal to keep the compensating control — delete addressesEdmund only
    // when this path is gone, not before.
    const harness = makeHarness(["something the neighbours said"]);
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:unscored");
    await tick();
    expect(harness.enqueued).toHaveLength(0);

    const named = makeHarness(["Edmund turn the lights on"]);
    named.orchestrator.onWake();
    await named.orchestrator.onUtterance("wav", "utterance:named");
    await tick();
    expect(named.enqueued).toHaveLength(1);
  });

  test("speech during a reply is ignored unless it names him", async () => {
    // The Pi's level gate is still calibrating on his bleed during the first
    // second of playback, which is exactly when the mic first hears him — so
    // early false wakes get through it. Requiring the name is deterministic
    // where a level threshold is not.
    const harness = makeHarness(["open the conversation", "yeah that sounds good to me"]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Here is a long weather summary for you.", "turn:one");
    const before = harness.enqueued.length;
    await harness.orchestrator.onUtterance("wav", "utterance:noise");
    await tick();

    expect(harness.enqueued.length - before).toBe(0);
    expect(harness.stops).toHaveLength(0);
    expect(harness.resumes).toBeGreaterThan(0);
  });

  test("naming him mid-reply does interrupt", async () => {
    const harness = makeHarness(["open the conversation", "Edmund, show me the radar instead"]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Here is a long weather summary for you.", "turn:one");
    await harness.orchestrator.onUtterance("wav", "utterance:barge");
    await tick();

    expect(harness.stops.length).toBeGreaterThan(0);
    // The name is stripped before the request reaches the model.
    expect(harness.enqueued.at(-1)?.message.text).toBe("show me the radar instead");
  });

  test("the name is accepted anywhere in the sentence, not just the front", async () => {
    const harness = makeHarness(["open the conversation", "stop talking Edmund"]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Here is a long weather summary for you.", "turn:one");
    await harness.orchestrator.onUtterance("wav", "utterance:barge");
    await tick();

    expect(harness.stops.length).toBeGreaterThan(0);
  });

  test("no invocation is needed once he has stopped speaking", async () => {
    // The follow-up window is the normal way to keep talking; demanding the
    // wake word there would break ordinary back-and-forth.
    const harness = makeHarness(["open the conversation", "and what about tomorrow"]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Seventy two and sunny.", "turn:one");
    harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
    await tick();

    await harness.orchestrator.onUtterance("wav", "utterance:followup");
    await tick();
    expect(harness.enqueued.at(-1)?.message.text).toBe("and what about tomorrow");
  });

  describe("interim speech during a long turn", () => {
    // The model can talk mid-turn via speak_on_mirror ("give me a second")
    // while it keeps working. That speech finishing is NOT the turn ending.
    test("interim speech does not hand the floor back or show Listening", async () => {
      const harness = makeHarness();
      await harness.orchestrator.onUtterance("wav", "utterance:long");
      harness.orchestrator.onTurnStarted("turn:long");
      harness.orchestrator.onModelPhase("turn:long", "working");

      await harness.orchestrator.speak("Give me a bit.", "tool");
      harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
      await tick();

      expect(harness.followups).toBe(0);
      expect(harness.overlays.at(-1)).toMatchObject({ phase: "working" });
    });

    test("the turn's own completion still settles the volley", async () => {
      const harness = makeHarness();
      await harness.orchestrator.onUtterance("wav", "utterance:long");
      harness.orchestrator.onTurnStarted("turn:long");
      harness.orchestrator.onModelPhase("turn:long", "working");

      await harness.orchestrator.speak("Give me a bit.", "tool");
      harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
      await tick();
      expect(harness.followups).toBe(0);

      await harness.orchestrator.deliver("Here is the new layout.", "turn:long");
      await harness.orchestrator.onTurnSettled("turn:long", "delivered");
      harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
      await tick();

      expect(harness.followups).toBe(1);
    });

    /**
     * The reported failure, start to finish.
     *
     * "It says it will take a minute, then it goes to listening, then listening
     * disappears and there is no chat screen, then randomly the screen updates."
     *
     * Every beat of that is one turn ending while its WORK continues: the model
     * acknowledges, spawns an agent and finishes its turn, so the volley closed,
     * the dock folded, and the eventual answer arrived as a silent repaint.
     */
    async function delegatingTurn() {
      const harness = makeHarness();
      await harness.orchestrator.onUtterance("wav", "utterance:long");
      harness.orchestrator.onTurnStarted("turn:long");
      harness.orchestrator.onModelPhase("turn:long", "working", "running a sub-task");
      await harness.orchestrator.speak("Give me a minute.", "tool");
      // The agent is spawned inside an MCP subprocess; the daemon only learns
      // of it when the watcher next reads the agents table.
      harness.orchestrator.onBackgroundWork(jobs("agent:research"));
      // …and the turn that started it ends right there.
      await harness.orchestrator.onTurnSettled("turn:long", "tool-only");
      harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
      await tick();
      return harness;
    }

    test("the acknowledgement still opens a follow-up window", async () => {
      // He just heard "give me a minute" — he gets his chance to answer it.
      // The hand-off to the background dock happens when that lapses, not the
      // instant the turn ends.
      const harness = await delegatingTurn();
      expect(harness.followups).toBe(1);
      expect(harness.overlays.at(-1)?.phase).toBe("responding");
    });

    test("a job that outlives its turn keeps the dock, and the thread goes", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.onListenTimeout();
      await tick();

      const last = harness.overlays.at(-1)!;
      expect(last.phase).toBe("working");
      // Empty, not absent: the screen reads a missing list as "keep what you
      // had", which would leave the finished exchange under a dock that is now
      // about something else.
      expect(last.messages).toEqual([]);
      expect(last.agents).toBe(1);
      expect(last.detail).toBe("still working in the background");
    });

    test("the result is spoken when it lands, not painted silently", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.onListenTimeout();
      await tick();
      const before = harness.rendered.length;

      // The agent finishes and its completion cron fires a fresh turn.
      harness.orchestrator.onBackgroundWork(jobs());
      harness.orchestrator.onTurnStarted("turn:result");
      const delivery = await harness.orchestrator.deliver(
        "Found three places that deliver.",
        "turn:result",
      );

      expect(delivery.delivered).toBe(true);
      expect(harness.audio.at(-1)?.text).toBe("Found three places that deliver.");
      // renderPassiveReply is the silent path — the whole defect was landing here.
      expect(harness.rendered.length).toBe(before);
    });

    test("with no job in flight the dock folds exactly as it always did", async () => {
      // The regression guard for the change itself: holding for background
      // work must not have taught the dock to stay open in the normal case.
      const harness = await delegatingTurn();
      harness.orchestrator.onBackgroundWork(jobs());
      harness.orchestrator.onListenTimeout();
      await tick();
      expect(harness.overlays.at(-1)?.phase).toBe("idle");
    });

    test("a settled job stops holding the dock on the next reconcile", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.onListenTimeout();
      await tick();
      expect(harness.overlays.at(-1)?.phase).toBe("working");

      // The agent exits. The dock is not folded here on purpose — its result
      // arrives as a wake-up turn a couple of seconds later, and folding into
      // that would be the same flicker in reverse.
      harness.orchestrator.onBackgroundWork(jobs());
      harness.orchestrator.onListenTimeout();
      await tick();
      expect(harness.overlays.at(-1)?.phase).toBe("idle");
    });

    test("an explicit goodbye dismisses the dock without cancelling the job", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.closeConversation("user said bye");
      await tick();
      expect(harness.overlays.at(-1)?.phase).toBe("idle");

      // The job is still running and still reported — it just no longer owns
      // the glass. A later reconcile must not resurrect the dock for it.
      harness.orchestrator.onBackgroundWork(jobs("agent:research"));
      await tick();
      expect(harness.overlays.at(-1)?.phase).toBe("idle");
    });

    test("a job spawned after a goodbye is not pre-dismissed", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.closeConversation("user said bye");
      await tick();
      // The dismissed job settles, then a new conversation spawns another.
      harness.orchestrator.onBackgroundWork(jobs());
      await harness.orchestrator.onUtterance("wav", "utterance:second");
      harness.orchestrator.onTurnStarted("turn:second");
      await harness.orchestrator.onTurnSettled("turn:second", "tool-only");
      harness.orchestrator.onBackgroundWork(jobs("agent:later"));
      await tick();
      expect(harness.overlays.at(-1)).toMatchObject({ phase: "working", agents: 1 });
    });

    test("reconciling the same jobs twice changes nothing", async () => {
      const harness = await delegatingTurn();
      harness.orchestrator.onBackgroundWork(jobs("agent:research"));
      await tick();
      const count = harness.overlays.length;
      harness.orchestrator.onBackgroundWork(jobs("agent:research"));
      harness.orchestrator.onBackgroundWork(jobs("agent:research"));
      await tick();
      // Re-projecting an unchanged frame is harmless but should not be a storm.
      expect(harness.overlays.length - count).toBeLessThanOrEqual(2);
    });

    test("a live turn with sub-agents keeps its thread", async () => {
      const harness = makeHarness();
      await harness.orchestrator.onUtterance("wav", "utterance:long");
      harness.orchestrator.onTurnStarted("turn:long");
      harness.orchestrator.onBackgroundWork(jobs("agent:one", "agent:two"));
      harness.orchestrator.onModelPhase("turn:long", "working", "running a sub-task");
      await tick();

      const last = harness.overlays.at(-1)!;
      expect(last.agents).toBe(2);
      // The exchange is still what the dock is about; only the presence changes.
      expect(last.messages?.length).toBeGreaterThan(0);
      expect(last.detail).toBe("running a sub-task");
    });

    test("falls back to working when the model reported no phase", async () => {
      const harness = makeHarness();
      await harness.orchestrator.onUtterance("wav", "utterance:long");
      harness.orchestrator.onTurnStarted("turn:long");

      await harness.orchestrator.speak("One moment.", "tool");
      harness.orchestrator.onAudioDone(false, harness.audio.at(-1)!.id);
      await tick();

      expect(harness.followups).toBe(0);
      expect(harness.overlays.at(-1)?.phase).toBe("thinking");
    });
  });

  test("a real interruption stops the ducked audio", async () => {
    const harness = makeHarness([
      "open the conversation",
      "Edmund actually show me the radar instead",
    ]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Here is a long weather summary.", "turn:one");
    await harness.orchestrator.onUtterance("wav", "utterance:barge");
    await tick();

    expect(harness.stops.length).toBeGreaterThan(0);
    expect(harness.enqueued.at(-1)?.message.text).toBe("actually show me the radar instead");
  });

  test("echo memory does not leak across a closed conversation", async () => {
    const harness = makeHarness(["open the conversation"]);
    await harness.orchestrator.onUtterance("wav", "utterance:open");
    harness.orchestrator.onTurnStarted("turn:one");
    await harness.orchestrator.deliver("Chocolate and tuna infuse together.", "turn:one");
    harness.orchestrator.closeConversation("test");
    // Nothing should throw once the volley is gone; the guard is stateless
    // beyond its own time window.
    expect(harness.enqueued).toHaveLength(1);
  });
});

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A wake capture and a follow-up capture arrive on the same endpoint but mean
 * different things. The Pi posts /wake before a wake capture and nothing at
 * all before a follow-up, so `onWake` is the only signal that a cheap,
 * error-prone detector claimed it heard the name — and the only place it is
 * worth spending a real transcript to check.
 */
describe("MirrorOrchestrator false-wake rejection", () => {
  test("a wake capture with no name in it starts no turn", async () => {
    const harness = makeHarness("can you hand me the second one");
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:kitchen");
    await tick();

    expect(harness.enqueued).toHaveLength(0);
    // And the glass goes back to idle rather than sitting on the spinner the
    // Pi projected when it uploaded the capture.
    expect(harness.overlays.at(-1)).toMatchObject({ phase: "idle" });
  });

  test("a wake capture that names him runs, with the name stripped", async () => {
    const harness = makeHarness("Edmund, what's the weather");
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:real");
    await tick();

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.message.text).toBe("what's the weather");
  });

  test("a follow-up inside an open volley never needs the name", async () => {
    // The whole point of the follow-up window: you answer a question without
    // re-addressing him. This capture arrives with no preceding onWake.
    const harness = makeHarness(["Edmund, show today", "and what about tomorrow"]);
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:first");
    await tick();
    await harness.orchestrator.onUtterance("wav", "utterance:followup");
    await tick();

    expect(harness.enqueued).toHaveLength(2);
    expect(harness.enqueued[1]!.message.text).toBe("and what about tomorrow");
  });

  test("a job still running keeps the dock rather than folding on a false wake", async () => {
    const harness = makeHarness(["Edmund, research that", "so anyway I told her no"]);
    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:start");
    harness.orchestrator.onBackgroundWork(jobs("agent:one"));
    await tick();

    harness.orchestrator.onWake();
    await harness.orchestrator.onUtterance("wav", "utterance:noise");
    await tick();

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.overlays.at(-1)).not.toMatchObject({ phase: "idle" });
  });
});

/**
 * The roster says what Edmund is off doing while he is off doing it.
 *
 * The model cannot supply this: `spawn_agent` runs inside an MCP subprocess,
 * so the turn that started a job ends without ever learning whether it is
 * still running. A roster the model wrote would be a claim about the past.
 */
describe("the agent roster", () => {
  const job = (id: string, task: string, ageMs = 0) => ({
    id,
    task,
    spawnedAtMs: Date.now() - ageMs,
  });

  test("names the work rather than just reporting that there is some", () => {
    const harness = makeHarness();
    harness.orchestrator.onBackgroundWork([
      job("a", "pull the CPIHL eligibility numbers", 3 * 60_000),
      job("b", "check flights to Boston"),
    ]);

    const roster = harness.rendered.filter((item) => item.component === "agent_activity").at(-1);
    expect(roster).toBeDefined();
    expect(roster).toMatchObject({ id: "system:agents", zone: "lower_third", priority: -20 });
    const jobs = (roster?.props as { jobs: Array<{ task: string; since?: string }> }).jobs;
    expect(jobs.map((entry) => entry.task)).toEqual([
      "pull the CPIHL eligibility numbers",
      "check flights to Boston",
    ]);
    // Coarse on purpose: a figure that changes every second makes the eye
    // return to it, and nobody reads "1 min 47 s" off a wall.
    expect(jobs[0]?.since).toBe("3 min");
    expect(jobs[1]?.since).toBe("just now");
  });

  test("carries a short lifetime, so it cannot outlive whatever writes it", () => {
    const harness = makeHarness();
    harness.orchestrator.onBackgroundWork([job("a", "reading the season archive")]);
    const roster = harness.rendered.filter((item) => item.component === "agent_activity").at(-1);

    // This is re-upserted on every reconcile tick, so the TTL only ever fires
    // when the thing writing it has stopped. A status display that outlives
    // the work it reports says something is happening when nothing is —
    // strictly worse than showing nothing at all.
    expect(roster?.lifespan).toBe("ephemeral");
    const ttlMs = (roster?.expiresAtMs as number) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(30_000);
  });

  test("comes off the glass when the last job settles", () => {
    const harness = makeHarness();
    harness.orchestrator.onBackgroundWork([job("a", "reading the season archive")]);
    expect(harness.removed).not.toContain("system:agents");

    harness.orchestrator.onBackgroundWork([]);
    expect(harness.removed).toContain("system:agents");

    // And only once — an idle mirror must not issue a removal every four
    // seconds forever.
    const after = harness.removed.length;
    harness.orchestrator.onBackgroundWork([]);
    expect(harness.removed.length).toBe(after);
  });

  test("a dismissed job stops being reported, even while it runs on", () => {
    // Dismissal is not cancellation: "bye" clears the glass, the work carries
    // on and still reports. What it must not do is keep claiming the roster.
    const harness = makeHarness();
    harness.orchestrator.onBackgroundWork([job("a", "still going")]);
    harness.orchestrator.dismissBackgroundWork();
    harness.orchestrator.onBackgroundWork([job("a", "still going")]);
    expect(harness.removed).toContain("system:agents");
  });
});
