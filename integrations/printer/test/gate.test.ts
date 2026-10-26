import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/approval.ts";
import { planFilaments } from "../src/filament.ts";
import { type GateInput, checkControlGate, checkStartGate, chooseRoute } from "../src/gate.ts";
import { type PrinterState, normalize } from "../src/report.ts";
import { type Approval, type Job, PrinterStore } from "../src/store.ts";

/**
 * Every condition on starting a print, broken one at a time. A gate that
 * passes the good case and fails each broken one is a gate; one that only
 * passes the good case is a decoration.
 */

const now = Date.now();
const APPROVER = "+15555550100";
const ORIGIN = "imessage:dm:+15555550101";

const state: PrinterState = normalize({
  command: "push_status",
  gcode_state: "FINISH",
  fun: "6403BFD1B3FF9CB3".replace("BF", "9F"),
  hms: [],
  ams: {
    ams: [
      {
        id: "0",
        tray: [
          { id: "0", state: 11, tray_type: "PLA", tray_color: "FFFFFFFF", tray_info_idx: "GFA01" },
          { id: "1", state: 11, tray_type: "PLA", tray_color: "C12E1FFF", tray_info_idx: "GFA00" },
          { id: "2", state: 10 },
          { id: "3", state: 10 },
        ],
      },
    ],
  },
});
// Developer Mode on: bit 29 clear.
state.developerMode = true;

const needs = [
  { index: 1, type: "PLA", color: "#FFFFFF", grams: 10 },
  { index: 2, type: "PLA", color: "#C12E1F", grams: 2 },
];
const plan = planFilaments(needs, state.ams.trays);

const job: Job = {
  id: 7,
  token: "t".repeat(32),
  title: "Dragon",
  requester: "Sam",
  requesterHandle: "+15555550101",
  originSession: ORIGIN,
  originChat: "any;-;+15555550101",
  file: "/tmp/x.gcode.3mf",
  source: "",
  plate: 1,
  plateType: "Textured PEI Plate",
  needs,
  prefer: {},
  estimateS: 3600,
  weightG: 12,
  settings: {},
  preview: "",
  status: "approved",
  designNote: "Sam: love it",
  remoteName: "",
  createdMs: now - 7200_000,
  updatedMs: now,
  startedMs: null,
  endedMs: null,
  endNote: "",
  finalPhoto: "",
  timelapse: "",
};

const approval: Approval = {
  id: 1,
  jobId: 7,
  action: "start",
  chatGuid: `any;-;${APPROVER}`,
  sessionKey: ORIGIN,
  askedMs: now - 600_000,
  askText: "ask",
  askGuid: "g",
  status: "approved",
  decidedMs: now - 300_000,
  decidedBy: APPROVER,
  decidedText: "yes",
  trays: "",
  plan,
  target: "",
  frameMs: null,
};

const decision: Decision = {
  verdict: "approve",
  by: APPROVER,
  text: "yes",
  ms: now - 300_000,
  guid: "r",
};

const good = (): GateInput => ({
  now,
  callerSession: ORIGIN,
  job: { ...job },
  approval: { ...approval },
  decision: { ...decision },
  approvers: [APPROVER],
  ttlMs: 12 * 3600_000,
  state: structuredClone(state),
  stateAgeMs: 2_000,
  plan,
  ownLookMs: now - 60_000,
  plateLook: { verdict: "CLEAR", frameMs: now - 30_000, note: "empty textured plate" },
  sendVia: "auto",
  connectReady: false,
  plateConfirm: null,
});

describe("starting a print", () => {
  test("everything right: it may start", () => {
    expect(checkStartGate(good())).toEqual({ ok: true, problems: [], route: "lan" });
  });

  const breaks: Array<[string, (g: GateInput) => void, RegExp]> = [
    [
      "another conversation",
      (g) => {
        g.callerSession = "imessage:dm:+15555550199";
      },
      /another conversation/,
    ],
    [
      "a draft job",
      (g) => {
        g.job.status = "draft";
      },
      /not approved/,
    ],
    [
      "no ask",
      (g) => {
        g.approval = null;
      },
      /Nobody has been asked/,
    ],
    [
      "an ask for another job",
      (g) => {
        g.approval!.jobId = 8;
      },
      /Nobody has been asked/,
    ],
    [
      "a used approval",
      (g) => {
        g.approval!.status = "used";
      },
      /approval is used/,
    ],
    [
      "no answer yet",
      (g) => {
        g.decision = null;
      },
      /No yes/,
    ],
    [
      "a no",
      (g) => {
        g.decision!.verdict = "decline";
      },
      /said no/,
    ],
    [
      "a yes from someone else",
      (g) => {
        g.decision!.by = "+15555550199";
      },
      /not come from an approver/,
    ],
    [
      "a yes older than the ask",
      (g) => {
        g.decision!.ms = g.approval!.askedMs - 1;
      },
      /before the ask/,
    ],
    [
      "a stale yes",
      (g) => {
        g.decision!.ms = now - 13 * 3600_000;
      },
      /too old/,
    ],
    [
      "no printer status",
      (g) => {
        g.state = null;
      },
      /No current status/,
    ],
    [
      "a stale status",
      (g) => {
        g.stateAgeMs = 5 * 60_000;
      },
      /No current status/,
    ],
    [
      "a busy printer",
      (g) => {
        g.state!.gcodeState = "RUNNING";
      },
      /not ready/,
    ],
    [
      "no Developer Mode and no Bambu Connect",
      (g) => {
        g.state!.developerMode = false;
      },
      /not in Developer Mode and Bambu Connect is not installed/,
    ],
    [
      "LAN forced without Developer Mode, though Bambu Connect is there",
      (g) => {
        g.state!.developerMode = false;
        g.sendVia = "lan";
        g.connectReady = true;
      },
      /not in Developer Mode/,
    ],
    [
      "Bambu Connect forced but not installed",
      (g) => {
        g.sendVia = "bambu_connect";
      },
      /Bambu Connect is not installed/,
    ],
    [
      "a serious HMS error",
      (g) => {
        g.state!.hms = [{ attr: 0x07000000, code: 0x00020001 }];
      },
      /serious error/,
    ],
    [
      "a color not loaded",
      (g) => {
        g.plan = planFilaments(
          needs,
          g.state!.ams.trays.map((t) => (t.trayId === 1 ? { ...t, color: "#0A5AD3" } : t)),
        );
      },
      /Not loaded yet/,
    ],
    [
      "the AMS rearranged since the yes",
      (g) => {
        const moved = g.state!.ams.trays.map((t) =>
          t.trayId === 1
            ? { ...t, loaded: false, type: "", color: "" }
            : t.trayId === 2
              ? { ...t, loaded: true, type: "PLA", color: "#C12E1F" }
              : t,
        );
        g.plan = planFilaments(needs, moved);
      },
      /AMS changed since the yes/,
    ],
    [
      "no plan on the approval",
      (g) => {
        g.approval!.plan = null;
      },
      /no filament plan/,
    ],
    [
      "Edmund did not look",
      (g) => {
        g.ownLookMs = null;
      },
      /Look at the plate yourself/,
    ],
    [
      "Edmund looked before the yes",
      (g) => {
        g.ownLookMs = g.decision!.ms - 1;
      },
      /Look at the plate yourself/,
    ],
    [
      "no independent look",
      (g) => {
        g.plateLook = null;
      },
      /did not run/,
    ],
    [
      "something on the plate",
      (g) => {
        g.plateLook!.verdict = "OCCUPIED";
      },
      /says occupied/,
    ],
    [
      "a dark picture",
      (g) => {
        g.plateLook!.verdict = "UNSURE";
      },
      /says unsure/,
    ],
    [
      "an old plate look",
      (g) => {
        g.plateLook!.frameMs = now - 10 * 60_000;
      },
      /within the last five minutes/,
    ],
  ];

  for (const [name, breakIt, why] of breaks) {
    test(`refuses: ${name}`, () => {
      const g = good();
      breakIt(g);
      const r = checkStartGate(g);
      expect(r.ok).toBe(false);
      expect(r.problems.join(" | ")).toMatch(why);
    });
  }

  describe("the approver confirming the plate from a photo", () => {
    // The print's yes was 5 minutes ago; the photo and the ask came after it.
    const unsure = (): GateInput => {
      const g = good();
      g.plateLook = { verdict: "UNSURE", frameMs: now - 30_000, note: "faint marks" };
      g.plateConfirm = {
        approval: {
          ...approval,
          id: 2,
          action: "plate",
          status: "pending",
          askedMs: now - 120_000,
          frameMs: now - 150_000,
          plan: null,
        },
        decision: {
          verdict: "approve",
          by: APPROVER,
          text: "yes it's clear",
          ms: now - 60_000,
          guid: "p",
        },
      };
      return g;
    };

    test("an unsure look plus the approver's yes: it may start", () => {
      expect(checkStartGate(unsure()).ok).toBe(true);
    });

    test("the approver's yes outranks an occupied look: they looked and said it is clear", () => {
      const g = unsure();
      g.plateLook = { verdict: "OCCUPIED", frameMs: now - 30_000, note: "a strand at the edge" };
      expect(checkStartGate(g).ok).toBe(true);
    });

    test("with no confirmation, an unsure look says how to ask for one", () => {
      const g = unsure();
      g.plateConfirm = null;
      expect(checkStartGate(g).problems.join(" ")).toMatch(/action "plate"/);
    });

    const breaks: Array<[string, (g: GateInput) => void, RegExp]> = [
      [
        "no answer yet",
        (g) => {
          g.plateConfirm!.decision = null;
        },
        /Waiting for the approver/,
      ],
      [
        "the approver said it is not clear",
        (g) => {
          g.plateConfirm!.decision!.verdict = "decline";
        },
        /not clear/,
      ],
      [
        "the answer is older than 15 minutes",
        (g) => {
          g.plateConfirm!.decision!.ms = now - 16 * 60_000;
          g.plateConfirm!.approval.askedMs = now - 17 * 60_000;
          g.plateConfirm!.approval.frameMs = now - 17 * 60_000;
          g.decision!.ms = now - 20 * 60_000;
          g.ownLookMs = now - 18 * 60_000;
        },
        /more than 15 minutes/,
      ],
      [
        "asked before the yes to the print",
        (g) => {
          g.plateConfirm!.approval.askedMs = now - 400_000;
        },
        /after the yes to this print/,
      ],
      [
        "a photo from before the yes",
        (g) => {
          g.plateConfirm!.approval.frameMs = now - 400_000;
        },
        /after the yes to this print/,
      ],
      [
        "answered by someone who is not an approver",
        (g) => {
          g.plateConfirm!.decision!.by = "+15555550199";
        },
        /did not come from an approver/,
      ],
      [
        "asked from another conversation",
        (g) => {
          g.plateConfirm!.approval.sessionKey = "imessage:dm:+15555550199";
        },
        /another conversation/,
      ],
      [
        "an answer from before the ask",
        (g) => {
          g.plateConfirm!.decision!.ms = now - 130_000;
        },
        /before the ask/,
      ],
    ];
    for (const [name, breakIt, why] of breaks) {
      test(`refuses: ${name}`, () => {
        const g = unsure();
        breakIt(g);
        const r = checkStartGate(g);
        expect(r.ok).toBe(false);
        expect(r.problems.join(" | ")).toMatch(why);
      });
    }

    test("a confirmation for another job does not count", () => {
      const g = unsure();
      g.plateConfirm!.approval.jobId = 99;
      expect(checkStartGate(g).problems.join(" ")).toMatch(
        /independent look at the plate says unsure/,
      );
    });
  });

  test("without Developer Mode, Bambu Connect carries the print", () => {
    const g = good();
    g.state!.developerMode = false;
    g.connectReady = true;
    expect(checkStartGate(g)).toEqual({ ok: true, problems: [], route: "bambu_connect" });
  });

  test("the route: the LAN when it is open, Bambu Connect when it is not", () => {
    expect(chooseRoute("auto", true, true).route).toBe("lan");
    expect(chooseRoute("auto", false, true).route).toBe("bambu_connect");
    expect(chooseRoute("auto", null, false).route).toBe("lan");
    expect(chooseRoute("auto", false, false).route).toBeNull();
    expect(chooseRoute("bambu_connect", true, true).route).toBe("bambu_connect");
    expect(chooseRoute("lan", false, true).route).toBeNull();
  });

  test("a substitute the person accepted passes the color check", () => {
    const g = good();
    const trays = g.state!.ams.trays.map((t) => (t.trayId === 1 ? { ...t, color: "#E0413A" } : t));
    g.job.prefer = { 2: 1 };
    g.plan = planFilaments(needs, trays, g.job.prefer);
    expect(checkStartGate(g).ok).toBe(true);
  });
});

describe("cancel and resume", () => {
  const ask: Approval = { ...approval, action: "cancel", jobId: null, target: "Dragon" };
  const base = {
    now,
    callerSession: ORIGIN,
    approval: ask,
    decision,
    approvers: [APPROVER],
    ttlMs: 12 * 3600_000,
    action: "cancel" as const,
  };

  test("a fresh yes to the cancel allows it", () => {
    expect(checkControlGate(base).ok).toBe(true);
  });

  test("a yes to a start is not a yes to a cancel", () => {
    expect(checkControlGate({ ...base, approval: { ...ask, action: "start" } }).ok).toBe(false);
  });

  test("a yes over two hours old does not cancel", () => {
    expect(
      checkControlGate({ ...base, decision: { ...decision, ms: now - 3 * 3600_000 } }).ok,
    ).toBe(false);
  });

  test("only the conversation that asked", () => {
    expect(checkControlGate({ ...base, callerSession: "imessage:dm:+15555550199" }).ok).toBe(false);
  });
});

describe("the store spends a yes once", () => {
  const dir = mkdtempSync(join(tmpdir(), "printer-store-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PrinterStore(dir);
  const j = store.createJob({ ...job, estimateS: 60 });

  test("only one start wins the job", () => {
    store.updateJob(j.id, { status: "approved" });
    expect(store.transition(j.id, ["approved"], "starting")).toBe(true);
    expect(store.transition(j.id, ["approved"], "starting")).toBe(false);
  });

  test("an approval is consumed once and can be given back", () => {
    const a = store.createApproval({
      jobId: j.id,
      action: "start",
      chatGuid: "c",
      sessionKey: ORIGIN,
      askedMs: now,
      askText: "",
      trays: "",
      plan: null,
    });
    expect(store.consume(a.id)).toBe(false);
    expect(store.decide(a.id, "approved", APPROVER, "yes", now + 1)).toBe(true);
    expect(store.decide(a.id, "declined", APPROVER, "no", now + 2)).toBe(false);
    expect(store.consume(a.id)).toBe(true);
    expect(store.consume(a.id)).toBe(false);
    store.restore(a.id);
    expect(store.consume(a.id)).toBe(true);
  });

  test("asking again replaces the earlier ask", () => {
    const a1 = store.createApproval({
      jobId: j.id,
      action: "cancel",
      chatGuid: "c",
      sessionKey: ORIGIN,
      askedMs: now,
      askText: "",
      trays: "",
      plan: null,
    });
    const a2 = store.createApproval({
      jobId: j.id,
      action: "cancel",
      chatGuid: "c",
      sessionKey: ORIGIN,
      askedMs: now + 5,
      askText: "",
      trays: "",
      plan: null,
    });
    expect(store.approval(a1.id)?.status).toBe("expired");
    expect(store.liveApproval(j.id, "cancel")?.id).toBe(a2.id);
  });

  test("a one-shot watch fires once; a repeating one keeps firing", () => {
    const once = store.addWatch({ sessionKey: ORIGIN, kind: "progress", threshold: 50 });
    expect(store.markFired(once.id, now)).toBe(true);
    expect(store.markFired(once.id, now)).toBe(false);
    const rep = store.addWatch({ sessionKey: ORIGIN, kind: "error", repeat: true });
    expect(store.markFired(rep.id, now)).toBe(true);
    expect(store.markFired(rep.id, now + 1)).toBe(true);
  });
});
