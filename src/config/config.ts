import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const ContactSchema = z.object({
  name: z.string().optional(),
  handles: z.array(z.string()).min(1),
});

export const ConfigSchema = z.object({
  self: z.object({
    handles: z.array(z.string()).default([]),
  }),
  allowlist: z.object({
    dm: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
  }),
  /**
   * Trust decisions, in one place. The defaults are the safe choice for a new
   * install. A deployment that wants the model to have the run of the host,
   * or wants every allowlisted contact treated as the operator, says so here
   * explicitly so the choice is visible in the config rather than implied by
   * an empty list.
   */
  security: z
    .object({
      /**
       * "sandboxed": Claude Code's built-in host tools (Bash, Read, Write,
       * Edit, Glob, Grep, NotebookEdit, WebFetch) are disallowed for every
       * session, the way they already are for guests; Codex keeps its own
       * sandbox and approval policy; model-authored scripts (data-trigger
       * predicates, refresh scripts) are not executed. The MCP tool surface
       * is unaffected. "full": Claude runs with bypassPermissions and Codex
       * with its sandbox and approvals disabled. The model can do anything
       * the user account running the daemon can.
       */
      model_host_access: z.enum(["sandboxed", "full"]).default("sandboxed"),
      /**
       * What an allowlisted handle that is not an operator gets. "contact":
       * this conversation only. No cross-chat messaging or errands, no
       * contact enumeration, no global or per-person recall scope, no global
       * self-memory writes, no skill publishing or marketplace installs.
       * "operator": every tool, as before this section existed. Groups are
       * always the contact tier under "contact", because the sender of a
       * group message is not known inside tool processes.
       */
      contact_tier: z.enum(["contact", "operator"]).default("contact"),
      /**
       * Handles that are the operator regardless of contact_tier. Empty
       * falls back to [alerts].operator_handle. Compared after handle
       * normalisation.
       */
      operator_handles: z.array(z.string()).default([]),
      /**
       * With [allowlist].dm empty, admit every DM sender. false means an
       * empty list admits nobody (guest access, if enabled, still applies).
       */
      open_dm_allowlist: z.boolean().default(false),
      /**
       * With [allowlist].groups empty, answer in any group that mentions the
       * assistant. false means an empty list registers no groups.
       */
      open_group_allowlist: z.boolean().default(false),
    })
    .default({
      model_host_access: "sandboxed",
      contact_tier: "contact",
      operator_handles: [],
      open_dm_allowlist: false,
      open_group_allowlist: false,
    }),
  /**
   * Keyed guest access — lets an unknown DM sender through the gate when they
   * present an active campaign key, and admits handles vouched by
   * co-membership in a registered group. Guests get the full persona on a
   * conversation-scoped session with a reduced tool surface; see
   * docs/design/guest-access-plan.md. `enabled = false` (the default) is the
   * exact pre-guest gate behavior.
   */
  guest_access: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  /**
   * One campaign per audience: an access key, a context markdown file
   * appended to keyed guests' system prompts, and per-campaign limits.
   * Key matching is case-insensitive everywhere (activation scan, dedupe).
   */
  guest_campaigns: z
    .array(
      z.object({
        /** The access key a sender must include in a DM. >= 8 chars so a
         *  casual word can't collide with it in normal conversation. */
        key: z.string().min(8, "guest campaign keys must be >= 8 chars"),
        /** Human label — used in operator alerts ("<label> key activated"). */
        label: z.string().min(1),
        /** Markdown file (repo-relative) appended to guest system prompts. */
        context: z.string().min(1),
        /** Optional ISO date. Past it the key is inert AND replies stop. */
        expires: z
          .string()
          .refine((s) => !Number.isNaN(Date.parse(s)), "expires must be an ISO date")
          .optional(),
        /** Lifetime USD ceiling for the campaign, via the spend ledger. */
        max_spend_usd: z.number().positive().optional(),
        /** Per-campaign daily message ceiling. */
        max_messages_per_day: z.number().int().positive().optional(),
      }),
    )
    .superRefine((campaigns, ctx) => {
      const seen = new Set<string>();
      for (const c of campaigns) {
        const norm = c.key.trim().toLowerCase();
        if (seen.has(norm)) {
          ctx.addIssue({ code: "custom", message: `duplicate guest campaign key "${c.key}"` });
        }
        seen.add(norm);
      }
    })
    .default([]),
  identity: z.object({
    names: z.array(z.string()).default(["claude"]),
  }),
  /** The human operator who runs this assistant. Surfaced in the system prompt
   *  (e.g. "an AI that <name> built") via the `{{owner}}` token; empty ⇒ the
   *  prompt falls back to the generic "your operator". */
  owner: z
    .object({
      name: z.string().default(""),
    })
    .default({}),
  /**
   * Additional named orchestrator personas beyond the built-in main one
   * (which is defined by [identity].names + the top-level persona/*.md
   * files). Each entry is invocable by name in any chat: "desmond, ..."
   * routes that message to the desmond orchestrator's own session, with
   * its own persona files (persona/orchestrators/<key>/, falling back
   * per-file to the shared top-level ones), and its own Claude Code model.
   *
   * Roles: exactly one orchestrator is "primary" — it receives un-named
   * DMs. If no entry claims primary, the built-in main persona is primary.
   * Messages that invoke a secondary are NEVER seen by the other
   * orchestrators (history + envelope + MCP history tools all filter).
   */
  orchestrators: z
    .array(
      z.object({
        /** Slug — session namespace and persona directory name. */
        key: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "lowercase slug (a-z, 0-9, -, _), max 32 chars"),
        /** Display name — how the persona refers to itself. */
        name: z.string().min(1),
        /** Trigger words that invoke this orchestrator ("desmond", "des"). */
        invocations: z.array(z.string().min(1)).min(1),
        role: z.enum(["primary", "secondary"]).default("secondary"),
        /** Model override; empty = inherit claude.model. */
        model: z.string().default(""),
      }),
    )
    .superRefine((entries, ctx) => {
      const RESERVED = new Set([
        "main",
        "operator",
        "ghost",
        "people_maintainer",
        "trading",
        "agents",
      ]);
      const keys = new Set<string>();
      const invocations = new Set<string>();
      let primaries = 0;
      for (const e of entries) {
        if (RESERVED.has(e.key)) {
          ctx.addIssue({ code: "custom", message: `orchestrator key "${e.key}" is reserved` });
        }
        if (keys.has(e.key)) {
          ctx.addIssue({ code: "custom", message: `duplicate orchestrator key "${e.key}"` });
        }
        keys.add(e.key);
        if (e.role === "primary") primaries++;
        for (const inv of e.invocations) {
          const norm = inv.trim().toLowerCase();
          if (!norm) continue;
          if (invocations.has(norm)) {
            ctx.addIssue({
              code: "custom",
              message: `invocation "${norm}" is used by more than one orchestrator`,
            });
          }
          invocations.add(norm);
        }
      }
      if (primaries > 1) {
        ctx.addIssue({ code: "custom", message: "at most one orchestrator can be primary" });
      }
    })
    .default([]),
  claude: z
    .object({
      model: z.string().default("claude-opus-4-8[1m]"),
      timeout_seconds: z.number().int().positive().default(180),
      /**
       * Effort level for the current session — translated to the selected
       * CLI's reasoning-effort setting.
       * Higher = more thinking, slower + more expensive. Lower = fast and
       * cheap. `high` is Opus 4.8's own default and spends ~the same token
       * budget 4.7 did at `high` while scoring higher — the cost-neutral
       * quality default. Drop to `medium` (skips thinking on trivial turns)
       * if iMessage latency matters more than depth for your deployment.
       */
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      /** Explicit provider context window. Codex receives this as
       *  `model_context_window`; omit to trust the CLI's model metadata. */
      context_window_tokens: z.number().int().positive().optional(),
      /**
       * Model for detached sub-agents (scripts/agent-runner.ts — the
       * `agent` MCP tool's research workers). Separate knob so agent burn
       * doesn't have to ride the operator's model. Empty = agent-runner's
       * built-in default.
       */
      agent_model: z.string().default("claude-sonnet-5"),
      /** Detached-agent effort. Omitted = inherit the main effort. */
      agent_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      /**
       * Claude-only resident worker pool. When enabled, the daemon keeps `claude -p
       * --input-format stream-json` subprocesses warm per session and reuses
       * them across turns — eliminates the ~500-1500 ms Node/CLI cold start
       * and lets Anthropic prompt caching kick in across turns.
       *
       * Off by default until proven in production. Toggle with `pool.enabled`.
       */
      pool: z
        .object({
          enabled: z.boolean().default(false),
          /** Cap on concurrent resident workers. Each ≈ 200-400 MB RSS. */
          max_workers: z.number().int().positive().default(6),
          /** Evict a worker after this many ms of no activity. 10 min default. */
          idle_evict_ms: z.number().int().positive().default(600_000),
        })
        .default({}),
      /**
       * Claude-only auto-compact: when a session's context window exceeds N tokens,
       * inject Claude Code's built-in `/compact` into the warm worker
       * (see src/claude/auto-compact.ts).
       *
       * Triggered off the ACTUAL context size — the largest single API
       * call in the turn, from the per-iteration usage Claude Code
       * reports on `result ok` — not the turn-cumulative cache reads,
       * which sum every tool-loop round-trip and overstate the context
       * by ~(round-trips)× on tool-heavy turns.
       */
      auto_compact: z
        .object({
          enabled: z.boolean().default(true),
          /** Trip threshold on the largest single API call's context
           *  (cache_read + cache_creation + input). Default 800k. */
          threshold_tokens: z.number().int().positive().default(800_000),
        })
        .default({}),
    })
    .default({
      model: "claude-opus-4-8[1m]",
      timeout_seconds: 180,
      effort: "high",
      agent_model: "claude-sonnet-5",
      pool: { enabled: false, max_workers: 6, idle_evict_ms: 600_000 },
      auto_compact: {
        enabled: true,
        threshold_tokens: 800_000,
      },
    }),
  /**
   * Codex-only overrides. Every field is optional and falls back to the
   * matching `[claude]` value, so a deployment that never sets a gpt/codex
   * model is unaffected by this block existing.
   *
   * It exists because the two CLIs were sharing one set of numbers that are
   * only correct for one of them. `[claude] effort` is tuned for Opus and was
   * handed unchanged to a reasoning model that spends it very differently, and
   * `[claude] context_window_tokens` reached Codex as `model_context_window` —
   * telling gpt-5.6-sol it had 400k when `codex debug models` reports 272k.
   * Overstating the window removes the headroom Codex uses to manage its own
   * context, trading a managed re-anchor for a hard API limit.
   */
  codex: z
    .object({
      /** Reasoning effort for codex turns. Unset = inherit `[claude] effort`. */
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      /**
       * `model_context_window` for codex turns. Unset — the default, and the
       * recommended setting — passes nothing, so Codex uses its own per-model
       * metadata. That is right for every model it knows and stays right when
       * the models change. Set this only to override a specific model on
       * purpose; it is NOT inherited from `[claude]`, which is the bug this
       * block exists to end.
       */
      context_window_tokens: z.number().int().positive().optional(),
      /**
       * Re-anchor threshold for codex threads. Unset = inherit
       * `[claude] auto_compact.threshold_tokens`. Codex `exec` cannot reach the
       * interactive `/compact` (verified: sending it as a prompt is treated as
       * literal text), so at this point the harness drops the thread id and the
       * next turn cold-starts from recent history.
       */
      threshold_tokens: z.number().int().positive().optional(),
    })
    .default({}),
  paths: z
    .object({
      chat_db: z.string().default("~/Library/Messages/chat.db"),
      data_dir: z.string().default("./data"),
    })
    .default({ chat_db: "~/Library/Messages/chat.db", data_dir: "./data" }),
  resources: z
    .object({
      /** Start releasing reconstructable caches and idle workers here. */
      memory_soft_mb: z.number().int().positive().default(4096),
      /** Gracefully recycle the launchd daemon after a sustained breach. */
      memory_hard_mb: z.number().int().positive().default(7168),
      sample_seconds: z.number().int().min(5).default(15),
      sustained_samples: z.number().int().min(2).default(3),
      restart_on_hard_limit: z.boolean().default(true),
    })
    .refine((v) => v.memory_soft_mb < v.memory_hard_mb, {
      message: "resources.memory_soft_mb must be below memory_hard_mb",
    })
    .default({}),
  keys: z
    .object({
      openai: z.string().default(""),
      gemini: z.string().default(""),
      elevenlabs: z.string().default(""),
      openrouter: z.string().default(""),
      brave: z.string().default(""),
      /** OpenRouter MANAGEMENT key (openrouter.ai/settings/provisioning-keys —
       *  OpenRouter renamed "provisioning" to "management" in 2026; same
       *  thing). Mints and edits per-person keys for [credits]; cannot run
       *  models. */
      openrouter_provisioning: z.string().default(""),
      /** Stripe secret key (sk_live_… / sk_test_…) — creates Checkout Sessions. */
      stripe_secret: z.string().default(""),
      /** Stripe publishable key (pk_…). Not needed for the hosted checkout
       *  page; accepted so it can live beside the others for an embedded form later. */
      stripe_publishable: z.string().default(""),
      /** Stripe webhook endpoint signing secret (whsec_…). Unset ⇒ every webhook rejected. */
      stripe_webhook_secret: z.string().default(""),
    })
    .default({
      openai: "",
      gemini: "",
      elevenlabs: "",
      openrouter: "",
      brave: "",
      openrouter_provisioning: "",
      stripe_secret: "",
      stripe_publishable: "",
      stripe_webhook_secret: "",
    }),
  tools: z
    .object({
      image_provider: z.enum(["openai", "gemini"]).default("openai"),
      image_model: z.string().default("gpt-image-1"),
      tts_voice: z.string().default("nova"),
      stt_model: z.string().default("whisper-1"),
    })
    .default({
      image_provider: "openai",
      image_model: "gpt-image-1",
      tts_voice: "nova",
      stt_model: "whisper-1",
    }),
  /**
   * `[sms]` — outbound/inbound SMS through Twilio.
   *
   * Disabled by default and inert when disabled: no routes mount, no
   * deliverer registers, and an `sms:` session cannot be created. Turning it
   * on is the only thing that lets the harness spend money on messaging.
   *
   * Credentials are read from the environment, never from this file:
   * TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET, plus
   * TWILIO_AUTH_TOKEN which is required SEPARATELY because webhook signature
   * validation can only be done with the auth token — an API key secret
   * cannot sign, and using one would reject every inbound message.
   */
  sms: z
    .object({
      enabled: z.boolean().default(false),
      /** Messaging Service SID (MG…). Strongly preferred over `from`: it owns
       *  the A2P campaign association, and sending from a bare number
       *  bypasses it. */
      messaging_service_sid: z.string().optional(),
      /** Fallback sender in E.164. Only used when no messaging service is set. */
      from: z.string().optional(),
      /** Public HTTPS origin the Twilio webhook is reached on. Signature
       *  validation hashes the URL Twilio dialed, so this must match the
       *  address configured in the Twilio console exactly. */
      public_base_url: z.string().optional(),
      /** Max SMS segments per outbound part. 3 ≈ 459 GSM-7 characters. */
      max_segments_per_message: z.number().int().positive().max(10).default(3),
      /** Max parts per reply. Beyond this the reply is truncated rather than
       *  sent — a nine-part text is worse than a short one. */
      max_parts: z.number().int().positive().max(10).default(3),
      /** Rewrite smart punctuation to GSM-7 before sending. One curly quote
       *  otherwise forces UCS-2 and roughly triples the segment count. */
      normalize_to_gsm7: z.boolean().default(true),
      /** True when Twilio Advanced Opt-Out answers STOP/HELP/START itself.
       *  Leaving this on while also replying here sends two messages. */
      carrier_handles_keywords: z.boolean().default(true),
      /** Reply body for HELP when we answer it ourselves. */
      help_text: z
        .string()
        .default(
          "This is an automated assistant line. Reply STOP to unsubscribe. Msg & data rates may apply.",
        ),
      /** Numbers allowed to start a conversation. Empty = anyone who texts in
       *  (still subject to the normal DM gate and guest tiers). */
      allowlist: z.array(z.string()).default([]),
      /** History lines pulled from the SMS transcript on a cold start. */
      history_messages: z.number().int().nonnegative().default(20),
      /** Loopback port the daemon's webhook listener binds. The named
       *  Cloudflare tunnel is the only route in from outside. */
      webhook_port: z.number().int().positive().default(4790),
      /** Admit SMS from numbers the contact book has never heard of. Off by
       *  default: a phone number is publicly dialable in a way an iMessage
       *  address is not, and an unknown sender reaching the model would
       *  arrive OUTSIDE the guest-tier machinery (sms sessions are not
       *  imessage:dm: keys). Turning this on is a deliberate act. */
      allow_unknown_senders: z.boolean().default(false),
    })
    .default({}),
  triggers: z
    .object({
      /** Model-authored data triggers (URL/app_js probes + predicates),
       *  evaluated by the daemon; fire = one-shot cron into the session. */
      enabled: z.boolean().default(true),
      /** Watcher loop tick; each trigger also has its own check interval. */
      tick_seconds: z.number().int().positive().default(60),
    })
    .default({}),
  /** `[radaromega]` — owned by integrations/radaromega/config.ts. Kept opaque
   *  here so the integration can be deleted without editing this schema. */
  radaromega: z.unknown().optional(),
  openrouter: z
    .object({
      /** Hard ceiling — the model can never pick an image model above this USD price per output image. */
      max_image_price_usd: z.number().positive().default(0.2),
      /** Hard ceiling USD per second of generated video. */
      max_video_price_per_second_usd: z.number().positive().default(0.5),
      /**
       * Hard ceiling on the audio model's primary-price field. Unit depends
       * on the model: USD/song for music models (Lyria), USD/min (≈) for
       * token-streamed TTS. Tune if you want to allow full-length songs at
       * $0.08 vs capping to sub-$0.05 clips.
       */
      max_audio_price_usd: z.number().positive().default(0.1),
      /** Fallback model when the model doesn't pick one. */
      /** Used for text-to-image (no reference photos attached). */
      default_image_model: z.string().default("google/gemini-3.1-flash-image-preview"),
      /** Used automatically when the model passes reference_images — reference-fidelity models beat creative-gen models for "put a hat on her" edits. */
      default_edit_model: z.string().default("black-forest-labs/flux.2-pro"),
      default_video_model: z.string().default("google/veo-3.1"),
      default_audio_model: z.string().default("openai/gpt-4o-audio-preview"),
      default_audio_voice: z.string().default("alloy"),
      /** Seconds between job-status polls for async video generation. */
      video_poll_interval_s: z.number().int().positive().default(20),
      /** Max wait for a video job before giving up. */
      video_max_wait_s: z.number().int().positive().default(600),
    })
    .default({
      max_image_price_usd: 0.2,
      max_video_price_per_second_usd: 0.5,
      max_audio_price_usd: 0.1,
      default_image_model: "google/gemini-3.1-flash-image-preview",
      default_edit_model: "black-forest-labs/flux.2-pro",
      default_video_model: "google/veo-3.1",
      default_audio_model: "openai/gpt-4o-audio-preview",
      default_audio_voice: "alloy",
      video_poll_interval_s: 20,
      video_max_wait_s: 600,
    }),
  /**
   * Per-person generation credits. Each DM gets its own provisioned
   * OpenRouter key whose spending limit is what that person has paid in;
   * they top it up from the Credits tab of their portal link. Groups, the
   * operator (alerts.operator_handle) and anyone switched to "house" on the
   * dashboard Credits page keep generating on keys.openrouter. See
   * docs/design/generation-credits-plan.md.
   */
  credits: z
    .object({
      enabled: z.boolean().default(false),
      /** Free credit a new wallet starts with. 0 = the first generation
       *  refuses and sends the top-up link. */
      starter_usd: z.number().min(0).default(0),
      /** Below this, every generation result carries a top-up nudge. */
      low_watermark_usd: z.number().min(0).default(1),
      /** Generation credit granted per $1 paid. Stripe takes 2.9% + $0.30 and
       *  OpenRouter charges 5.5% to buy credit; 0.90 leaves the operator
       *  absorbing about a cent on the dollar, 0.87 is neutral. */
      credit_ratio: z.number().positive().max(1).default(0.9),
      min_topup_usd: z.number().positive().default(5),
      max_topup_usd: z.number().positive().default(200),
      presets_usd: z.array(z.number().positive()).default([5, 10, 20]),
      /** Line-item name on the Stripe checkout page and receipt. */
      product_name: z.string().default("Edmund generation credit"),
      /** Existing Stripe Product (prod_…) the line item references, so every
       *  top-up rolls up under one product in Stripe. Empty = describe the
       *  product inline by name. */
      stripe_product_id: z.string().default(""),
      /** Product tax code (txcd_…) used when no stripe_product_id is set.
       *  Accounts on Stripe Managed Payments refuse line items without one.
       *  Default: AI as a Service, cloud based, personal use. */
      stripe_tax_code: z.string().default("txcd_10105001"),
    })
    .refine((v) => v.min_topup_usd <= v.max_topup_usd, {
      message: "credits.min_topup_usd must not exceed max_topup_usd",
    })
    .default({
      enabled: false,
      starter_usd: 0,
      low_watermark_usd: 1,
      credit_ratio: 0.9,
      min_topup_usd: 5,
      max_topup_usd: 200,
      presets_usd: [5, 10, 20],
      product_name: "Edmund generation credit",
      stripe_product_id: "",
      stripe_tax_code: "txcd_10105001",
    }),
  behavior: z
    .object({
      /** Max chars per iMessage chunk. */
      chunk_chars: z.number().int().positive().default(1800),
      /**
       * Idle debounce window for batching rapid-fire messages: each new
       * message resets the timer, so a burst flushes as one turn once the
       * sender pauses. 0 = no batching (flush immediately).
       */
      debounce_ms: z.number().int().nonnegative().default(1500),
      /**
       * Hard cap on how long a burst can hold the batch open. Even if the
       * sender keeps typing, the queue flushes after this many ms from the
       * first queued message. Keeps a chatty user from stalling forever.
       * Must be ≥ `bare_attachment_debounce_ms` + headroom or a bare photo
       * gets cut off before its caption arrives.
       */
      debounce_max_ms: z.number().int().nonnegative().default(10_000),
      /**
       * Debounce window when the queued message carries an attachment AND
       * its own caption text. Short — the message is self-contained, so a
       * quick answer is fine — but non-zero so a follow-up still batches.
       */
      attachment_debounce_ms: z.number().int().nonnegative().default(600),
      /**
       * Debounce window for a *bare* attachment (image/file with no text of
       * its own). Longer than the others: a bare photo is very often followed
       * a beat later by a caption or a question ("here's the thing" → "what
       * do you think?"), and answering the photo before that lands produces
       * two replies to what the sender meant as one message.
       */
      bare_attachment_debounce_ms: z.number().int().nonnegative().default(4000),
      /**
       * Debounce window for VOICE sessions (the mirror). Much shorter than
       * `debounce_ms`: the mic's VAD has already decided the speaker stopped,
       * so a transcript arriving here is a finished thought, not one burst of
       * a still-typing sender. Charging it the full typing debounce added
       * that delay to every spoken turn before the model even started —
       * dead air the user hears as lag. Kept non-zero so two utterances
       * that land back-to-back still fold into a single turn.
       */
      voice_debounce_ms: z.number().int().nonnegative().default(250),
      /**
       * If a message arrives while Claude is mid-turn for that thread, re-run
       * the turn once with the drafted reply + the new message(s) so the
       * model can synthesize one coherent answer (or keep its draft with
       * `KEEP_DRAFT`). Off = the new message just becomes the next turn.
       */
      coalesce_pending: z.boolean().default(true),
      /**
       * Liveness fallback: if a turn has run this many seconds with NO
       * user-facing sign of life, show the typing bubble.
       *
       * Typing normally starts as soon as the model emits a text block or does a
       * mid-turn send. A turn that only thinks and calls tools emits neither, so
       * it used to sit silent — and the harness filled that silence with a canned
       * "still on it" text instead, which landed as filler in front of the real
       * reply. The bubble says the same thing the way a person does, and clears
       * itself when the reply arrives.
       *
       * 0 disables. Replaces `working_notice_seconds`, which sent the text.
       */
      liveness_typing_seconds: z.number().int().nonnegative().default(15),
      /**
       * Durable ack-after-processing: every accepted inbound row is recorded
       * in state.db (inbound_ack) BEFORE the watcher cursor advances, and the
       * record is only deleted once a turn has answered it. Boot replays any
       * survivors through the catch-up coalescer, so a daemon killed inside
       * the debounce window can no longer silently lose a message. Off =
       * pre-2026-07 behavior (cursor advance alone marks a row as handled).
       */
      durable_pending_ack: z.boolean().default(true),
      /**
       * Master enable for native inline reply threading (the IMCore-bridge
       * `--reply-to`). When on, replies are still PLAIN by default — the model
       * opts a given reply into threading (prefix `[thread]`, or `send_message`
       * with `reply_to`). When off, no threading happens at all, ever.
       */
      reply_threading: z.boolean().default(true),
      /** How many past messages to show on a new session (cold start). */
      history_messages: z.number().int().nonnegative().default(20),
      /** If true, inject history on every turn (usually unnecessary since claude --resume remembers). */
      history_always: z.boolean().default(false),
      /** Inject the group participant roster on every group turn. */
      participant_roster: z.boolean().default(true),
      /** Reset session (cold-start next turn) if no activity for this long. 0 = never. */
      session_idle_hours: z.number().nonnegative().default(72),
      /** Auto-transcribe inbound audio attachments with Whisper before Claude sees them. */
      transcribe_inbound_audio: z.boolean().default(true),
      /**
       * Fire an iMessage typing indicator the moment an inbound is accepted
       * for a turn — before the model is even invoked. The user sees the
       * "…" bubble within ~10 ms instead of waiting 3-15s for the model to
       * (maybe) call `activate_typing` itself. Requires `imsg` on PATH.
       * The model can still call `activate_typing` mid-turn to extend.
       */
      auto_typing: z.boolean().default(true),
      /** How long the auto-fired typing bubble lasts. Long enough to span a
       *  typical turn; short enough that a daemon crash mid-turn doesn't
       *  leave a ghost bubble for too long. */
      auto_typing_seconds: z.number().int().min(5).max(120).default(30),
      /** Group history segmenter: silence (minutes) that ends a conversation
       *  thread. Anything older than this gap is treated as a separate
       *  conversation — out of scope for the current invocation unless the
       *  model explicitly fetches it via get_thread_context / catch_me_up. */
      thread_break_minutes: z.number().int().positive().default(30),
      /** Within a thread, gaps (minutes) above this get a visible `--- Xm gap ---`
       *  marker injected in the rendered history, so the model can see
       *  topic-shift boundaries without doing timestamp arithmetic. */
      topic_shift_minutes: z.number().int().positive().default(5),
      /** Hard cap on messages rendered per active segment. If the segment is
       *  longer, the tail is kept and a "(N earlier messages omitted)" line
       *  is prefixed; the model can fetch them with get_thread_context. */
      history_max_per_segment: z.number().int().positive().default(30),
      /** How many candidate messages to fetch before segmenting. Generous —
       *  the segmenter trims down. Tune up if very long active threads (>80
       *  msgs without a 30m break) become common. */
      history_candidate_window: z.number().int().positive().default(80),
      /** When true, load venue-specific guidance from two separate prompt
       *  files (persona/VENUE_GROUP.md, persona/VENUE_DM.md) instead of
       *  using the hard-coded venue blurb in code. Lets you tune the two
       *  contexts independently — group chats need social-dynamics
       *  guidance the DM prompt would never use, and vice versa.
       *  When false, falls back to the legacy single-blurb behavior. */
      separate_group_prompts: z.boolean().default(true),
      /** Automatic catch_me_up nudge threshold. When the model is invoked
       *  in a group and more than this many messages have accumulated
       *  since its last reply, the envelope inserts a prominent hint
       *  telling it to call `catch_me_up` before responding. 0 = disabled.
       *  Counted across the candidate window, so the effective cap is
       *  history_candidate_window (default 80). */
      auto_catchup_threshold: z.number().int().nonnegative().default(25),
      /** On boot, coalesce any messages that piled up while the daemon was down into ONE turn
       *  per chat (flagged so the model knows it was offline and replies once or stays silent)
       *  instead of replaying them one-by-one. Prevents the recovery group-chat spam. */
      catchup_on_boot: z.boolean().default(true),
      /** Max chats catching up concurrently on recovery — backpressure so a big backlog drains
       *  steadily instead of swamping the worker pool. */
      catchup_concurrency: z.number().int().positive().default(3),
    })
    // Self-healing invariant: debounce_max_ms CLAMPS every other debounce
    // window (pipeline.ts applies min(window, maxMs)), so a max below the
    // bare-attachment grace silently re-enables the photo-before-caption
    // double-reply bug. Observed live 2026-07-28: debounce_max_ms=1000 cut
    // the 4000ms grace to 1s. Raise + warn instead of rejecting so a bad
    // edit can't keep the daemon from booting.
    .transform((b) => {
      if (b.debounce_max_ms > 0 && b.debounce_max_ms < b.bare_attachment_debounce_ms) {
        console.warn(
          `[config] behavior.debounce_max_ms (${b.debounce_max_ms}) < bare_attachment_debounce_ms (${b.bare_attachment_debounce_ms}) — it clamps every debounce window, so bare photos would flush before their caption arrives. Raising it to ${b.bare_attachment_debounce_ms}.`,
        );
        return { ...b, debounce_max_ms: b.bare_attachment_debounce_ms };
      }
      return b;
    })
    .default({
      chunk_chars: 1800,
      debounce_ms: 1500,
      debounce_max_ms: 10_000,
      attachment_debounce_ms: 600,
      bare_attachment_debounce_ms: 4000,
      voice_debounce_ms: 250,
      coalesce_pending: true,
      durable_pending_ack: true,
      reply_threading: true,
      history_messages: 20,
      history_always: false,
      participant_roster: true,
      session_idle_hours: 72,
      transcribe_inbound_audio: true,
      auto_typing: true,
      auto_typing_seconds: 30,
      thread_break_minutes: 30,
      topic_shift_minutes: 5,
      history_max_per_segment: 30,
      history_candidate_window: 80,
      separate_group_prompts: true,
      auto_catchup_threshold: 25,
      catchup_on_boot: true,
      catchup_concurrency: 3,
    }),
  alerts: z
    .object({
      /** Where to deliver operator alerts (auth failures, runner crashes, etc.). Phone/email. Empty = alerts disabled. */
      operator_handle: z.string().default(""),
      /** Minimum minutes between alerts with the same error signature. Prevents spam during persistent outages. */
      min_interval_minutes: z.number().int().positive().default(30),
    })
    .default({ operator_handle: "", min_interval_minutes: 30 }),
  dashboard: z
    .object({
      /** HTTP port for the local dashboard server. */
      port: z.number().int().positive().default(4747),
      /** Bind address. "127.0.0.1" = this Mac only (default); "0.0.0.0" = every interface, which puts a PIN-gated http UI on your LAN. */
      bind: z.string().default("127.0.0.1"),
      /** Bun.password.hash of the dashboard PIN. Set via `bun run dashboard:set-pin <pin>`. Empty = dashboard refuses logins. */
      pin_hash: z.string().default(""),
      /** How long a login cookie stays valid. */
      session_days: z.number().int().positive().default(30),
      /**
       * Public base URL (e.g. https://edmund.example.com) used when tools build
       * links that the user opens on their phone. Set this if you've put a
       * tunnel (cloudflared, ngrok, tailscale funnel) in front of the
       * dashboard; otherwise tools fall back to http://<LAN-IP>:<port> which
       * only works when the phone is on the same network as the host Mac.
       */
      external_url: z.string().default(""),
      /** Public-only listener: serves ONLY the token-gated user routes
       *  (/u portal, /a annotate) with a 404 for everything else. Bound to
       *  127.0.0.1 — reachable exclusively through the cloudflared tunnel
       *  (scripts/setup-portal-tunnel.sh). The PIN dashboard/API/SPA stay
       *  on `port` and are never exposed. */
      public_port: z.number().int().positive().default(4749),
    })
    .default({
      port: 4747,
      bind: "127.0.0.1",
      pin_hash: "",
      session_days: 30,
      external_url: "",
      public_port: 4749,
    }),
  /** `[cloudflare]` — owned by integrations/cloudflare-browser/config.ts. */
  cloudflare: z.unknown().optional(),
  /** `[trading]` — owned by integrations/trading/config.ts. */
  trading: z.unknown().optional(),
  /** `[fishing]` — owned by integrations/fishing/config.ts. */
  fishing: z.unknown().optional(),
  contacts: z.array(ContactSchema).default([]),
  /**
   * Stuck-session recovery sweep. Periodically checks for sessions where
   * the user sent a message and we never replied; heals known structural
   * errors (32 MB request limit, oversized images, stale session ids)
   * and invokes the model with a recovery-context envelope so it decides
   * whether to reply, stay silent, or pivot. See docs/design/recovery-plan.md.
   */
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      /** How often the sweep runs. */
      sweep_interval_seconds: z.number().int().positive().default(60),
      /** Minimum age of an unanswered inbound before recovery may fire. */
      stale_threshold_seconds: z.number().int().positive().default(90),
      /** Per-session cooldown between recovery attempts. */
      cooldown_minutes: z.number().int().positive().default(30),
      /** Operator alert after this many consecutive heal failures for one session. */
      max_heal_failures_before_alert: z.number().int().positive().default(3),
      /** Sessions older than this since last inbound are considered dormant. */
      max_age_hours: z.number().int().positive().default(24),
      /**
       * Fallback notice — the never-go-silent backstop. If a thread still
       * owes a reply this long after the burst's last inbound (i.e. healing
       * + recovery turns haven't produced anything user-visible), send ONE
       * short out-of-band "still on it" note. Tracked per burst via
       * sessions.last_fallback_ms: a burst gets at most one notice, and a
       * new inbound after the notice re-arms it. The real reply still flows
       * through the normal recovery path afterwards.
       */
      fallback_notice_enabled: z.boolean().default(true),
      /** How long a burst may sit unanswered before the notice fires. Keep
       *  comfortably above stale_threshold_seconds (and the claude turn
       *  timeout) so recovery gets a real shot at delivering the actual
       *  reply first — the notice is meant to be rare. */
      fallback_notice_after_minutes: z.number().int().positive().default(10),
      /** The notice text. Kept short and persona-neutral; sent verbatim. */
      fallback_notice_text: z.string().default("hit a snag getting back to you — still on it"),
    })
    .default({}),
  /**
   * Inbound watcher.
   *
   * chat.db is always the source of truth and its poll always runs, so this only
   * controls whether bridge events additionally wake that poll sooner. It used
   * to select between sources, and a push stream that went silent while looking
   * alive could then leave inbound unseen for as long as nobody noticed.
   *
   *   "auto" — poll plus bridge events. Sub-100ms inbound latency. Recommended.
   *   "fs"   — the poll alone: fs.watch on chat.db and chat.db-wal with a 200ms
   *            PRAGMA data_version backstop.
   *
   * "imsg" is accepted as a spelling of "auto", for configs written before the
   * push source stopped being a separate thing.
   */
  imessage_watcher: z
    .object({
      source: z.enum(["auto", "imsg", "fs"]).default("auto"),
    })
    .default({}),
  /**
   * How the bridge into Messages is kept alive.
   *
   * There is no transport to choose any more, so the old `path` (auto / bridge /
   * legacy / applescript) and its retry envelope are gone. Retries are bounded
   * inside the send itself and safe by construction, because every attempt
   * carries an idempotency key.
   *
   * What is worth tuning is how aggressively a wedged bridge is caught: the
   * injected code can hold the socket open and stop answering, and only a probe
   * with a deadline tells the difference between that and a quiet hour.
   */
  imessage_send: z
    .object({
      /** How often to prove Messages still answers. 0 disables probing. */
      health_interval_ms: z.number().int().nonnegative().default(30_000),
      /** How long a probe may take before it counts as missed. */
      health_timeout_ms: z.number().int().positive().default(5_000),
      /**
       * Refuse, in the injected code itself, every send that targets this
       * account's own address. Edmund drives its own iCloud account, so it
       * has no legitimate note-to-self traffic — anything landing there is a
       * misroute. On by default; the reactive verify-and-heal path stays as
       * the net for the window before a relaunch carries this to Messages.
       */
      block_self_sends: z.boolean().default(true),
    })
    .default({}),
  /**
   * Cross-session message relay (`send_message` MCP tool). Lets a bot in
   * one session text a contact who has their own session, by routing the
   * message through the recipient's session. See docs/design/relay-plan.md.
   *
   *   "*"             — DM and group targets both allowed
   *   "dm_only"       — only DM targets
   *   "groupchat_only"— only group targets
   *   omitted         — relay disabled; tool returns an error if called
   */
  outbound: z
    .object({
      mode: z.enum(["*", "dm_only", "groupchat_only"]).optional(),
    })
    .default({}),
  /**
   * Whitelist for the IMCore-bridge "rich" iMessage actions. All of these
   * additionally require the bridge to be live (SIP disabled + `imsg launch`);
   * when it isn't, the tools simply aren't offered to the model. On top of
   * that, each action below must be individually enabled here.
   *
   * Defaults: the harmless / self-affecting / reversible ones are ON; anything
   * that changes a *shared* chat or another person's experience is OFF — turn
   * those on deliberately if you want them.
   */
  imessage_actions: z
    .object({
      /** Expressive send effects (confetti, lasers, slam, invisible ink, …) on outgoing messages. */
      effects: z.boolean().default(true),
      /** Bold subject-line header on outgoing messages. */
      subject_lines: z.boolean().default(true),
      /** Let the model edit its OWN recently-sent messages (iMessage's ~15 min window). */
      edit_messages: z.boolean().default(true),
      /** Let the model retract (unsend) its OWN recently-sent messages (~2 min window). */
      unsend_messages: z.boolean().default(true),
      /** Let the model delete a message from the local Messages history. Destructive — off by default. */
      delete_messages: z.boolean().default(false),
      /** Let the model rename a group chat. Affects everyone in the room — off by default. */
      rename_group: z.boolean().default(false),
      /** Let the model set/clear a group chat's photo. Off by default. */
      group_photo: z.boolean().default(false),
      /** Let the model add/remove participants or leave a group chat. Off by default. */
      manage_members: z.boolean().default(false),
      /** Let the model start a brand-new DM or group chat with arbitrary handles. Off by default. */
      create_chat: z.boolean().default(false),
    })
    .default({}),
  /**
   * Brown-nose mode — proactive, ghost-driven outreach. A "ghost"
   * observer (model set by `ghost_model` below) decides if/when to wake
   * the main model unprompted with a brief recommending an action. The
   * main model has final veto and can return KEEP_QUIET if context has
   * shifted by fire time.
   *
   * Architecture, behavior, and tuning live in docs/design/brownnose-plan.md.
   * This config block is the global defaults; per-session overrides
   * (active hours, enabled/disabled, focus suggestions) live in the
   * state.db `brown_nose_prefs` table, set via the `set_brown_nose`
   * MCP tool or the `edmund` CLI.
   */
  brown_nose: z
    .object({
      /** Master switch. False = ghost never runs anywhere. */
      enabled: z.boolean().default(true),
      /** Intensity 1-10. One knob that scales cooldown, weekly cap,
       *  sweep cadence, and ghost eagerness together. See the
       *  intensity table in docs/design/brownnose-plan.md. */
      intensity: z.number().int().min(1).max(10).default(5),
      /** DMs auto-enroll on first boot. */
      dms_enabled_by_default: z.boolean().default(true),
      /** Groups stay opt-in. To enable a specific group, use the
       *  `set_brown_nose` tool inside that chat. */
      groups_enabled_by_default: z.boolean().default(false),
      /** Model id for the ghost (live value in config.toml). The
       *  proactive-decision call ("real hook? right moment?") is where a
       *  misfire costs most, so it gets sharp judgment — but note ~95%
       *  of ticks return "no", so a cheaper model or pre-screen is the
       *  first lever if proactive spend bites. Bounded by
       *  max_ghost_ticks_per_day + intensity. */
      ghost_model: z.string().default("claude-opus-4-8"),
      /** Cheap triage pass before the full ghost deliberation: the fast
       *  model reads the same context and must say "plausibly yes" for the
       *  expensive tick to run (95.5% of full ticks said "no" in
       *  production). Fails open — a broken pre-screen never mutes the
       *  ghost. Bypassed by CLI --force. */
      prescreen_enabled: z.boolean().default(true),
      prescreen_model: z.string().default("claude-haiku-4-5-20251001"),
      /** Default timezone for newly-enrolled sessions. IANA name. */
      default_timezone: z.string().default("America/New_York"),
      /** Hard ceiling on ghost model ticks per session per day; defense
       *  against runaway loops. Independent of intensity. Enforced by the
       *  observer via the spend ledger's per-day tick count. */
      max_ghost_ticks_per_day: z.number().int().positive().default(20),
      /** Global concurrency cap: at most this many proactive_opportunity
       *  fires can be in-flight across ALL sessions at once. Cron rows
       *  that hit the cap defer with `fire_defer_*` jitter. */
      max_concurrent_fires: z.number().int().positive().default(3),
      /** Anti-clustering: when the ghost picks fireAtMs, it adds a
       *  uniform-random offset in this window. Prevents many sessions
       *  from all firing at the same "obvious" time. */
      schedule_jitter_min_minutes: z.number().int().nonnegative().default(0),
      schedule_jitter_max_minutes: z.number().int().positive().default(35),
      /** When the concurrency cap is hit at fire time, the cron row's
       *  fireAtMs is bumped by a random offset in this window. */
      fire_defer_min_minutes: z.number().int().positive().default(5),
      fire_defer_max_minutes: z.number().int().positive().default(15),
      /** Floor on time between any two fires (even when cap isn't full).
       *  Forces a global stagger. */
      min_seconds_between_fires: z.number().int().positive().default(90),
    })
    .default({}),
  /**
   * Persona-file maintainer — background pass that keeps
   * `persona/people/<handle>.md` (DMs) and `persona/groups/<slug>.md`
   * (groups) current. Triggered post-reply with a 60-120s deferred timer
   * and a per-session min-interval floor. Decoupled from the brown-nose
   * ghost: turning proactive outreach off does NOT mute memory hygiene.
   */
  people_maintainer: z
    .object({
      enabled: z.boolean().default(true),
      /** Schema default is the cheap tier — durable-fact extraction
       *  doesn't need more. NOTE: config.toml currently overrides this
       *  upward (deliberate? it runs per active session every
       *  min_interval_minutes, so the delta compounds). */
      model: z.string().default("claude-haiku-4-5"),
      /** Per-session min interval. Bursty back-and-forth replies
       *  collapse to one maintenance run per this window. */
      min_interval_minutes: z.number().int().positive().default(15),
      /** Recent chat.db messages to feed the maintainer per run. */
      recent_messages: z.number().int().positive().default(30),
      /** When true: log proposed updates but don't write to disk.
       *  Useful for the first few days while tuning the prompt. */
      dry_run: z.boolean().default(false),
    })
    .default({}),
  /**
   * Eval loop v1 (Phase 5): weekly judged sample of real outbound
   * transcripts + a fixed probe set replayed whenever the persona /
   * output-contract fingerprint changes. Scores land in spend.db
   * (eval_runs / eval_scores); a per-axis average drop ≥ regression
   * threshold vs the previous run of the same kind raises an operator
   * alert. Judging is one Haiku call per sample — cents per week.
   */
  evals: z
    .object({
      enabled: z.boolean().default(true),
      /** Judge model — scores transcripts against the output contract. */
      judge_model: z.string().default("claude-haiku-4-5-20251001"),
      /** Transcript slices judged per weekly run. */
      weekly_samples: z.number().int().positive().max(30).default(8),
      /** Replay the fixed probe set when persona/system-prompt changes. */
      probe_on_persona_change: z.boolean().default(true),
      /** Model that GENERATES probe replies (empty = the main model). */
      probe_model: z.string().default(""),
      /** Alert when an axis average drops by at least this much. */
      regression_threshold: z.number().positive().default(2),
    })
    .default({}),
  /**
   * Skill marketplace — self-extending skills installed from a curated
   * registry. Skills live in `./skills/<name>/SKILL.md` and are picked up
   * by the progressive `list_skills`/`read_skill` loader automatically;
   * the marketplace adds a search/install path on top of that.
   *
   * Source allowlist is enforced: an install from anything outside
   * `allowed_sources` is rejected. Each source is `owner/repo` on GitHub
   * — the registry fetches `marketplace.json` from the default branch.
   *
   * First use of any installed skill that ships executable content
   * (scripts/, shebangs) requires explicit operator approval via the
   * `edmund skills approve <name>` CLI.
   */
  /**
   * Semantic recall — embedding index over iMessage history (+ optional
   * artifacts) for fuzzy/paraphrase recall. Backs the `semantic_search`
   * MCP tool. Independent of the substring-based `search_history`.
   *
   * Defaults: enabled, OpenAI text-embedding-3-small (1536-dim). To keep
   * iMessage off the wire entirely, point `provider` at a local Ollama
   * endpoint via `provider = "ollama"` + `endpoint`.
   *
   * Scope rules enforced at tool boundary: default scope is "this-chat".
   * Cross-chat queries require explicit scope= argument from the model
   * (the persona is taught the cross-boundary rule).
   */
  memory_recall: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.enum(["openai", "ollama", "transformers", "none"]).default("transformers"),
      /** Model id passed through to the provider. For transformers use a
       *  HuggingFace repo id. Default is bge-small-en-v1.5: same dims/
       *  speed as MiniLM-L6 but ~10 points better retrieval nDCG and a
       *  512-token window; the provider applies its query-side prefix +
       *  CLS pooling automatically (see embed-provider.ts familyFor). */
      model: z.string().default("Xenova/bge-small-en-v1.5"),
      /** Embedding vector dimensionality. Must match the model. */
      dim: z.number().int().positive().default(384),
      /** Ollama HTTP endpoint when provider = "ollama". */
      ollama_endpoint: z.string().default("http://127.0.0.1:11434"),
      /** How many texts to embed in one provider call. Higher = better
       *  CPU/GPU utilization, more memory per call. 128 is a good
       *  middle for MiniLM on a Mac mini. */
      batch_size: z.number().int().positive().default(128),
      /** Max rows fetched from chat.db per indexer tick. Higher =
       *  better throughput during backfill, lower = less RAM spike. */
      chunk_size: z.number().int().positive().default(2000),
      /** When set, fire the next tick immediately after one that
       *  returned ≥ this many newly-indexed rows. Lets the indexer
       *  chew through a fresh backfill at full speed without waiting
       *  the 60s interval. Set to 0 to disable adaptive ticking. */
      adaptive_retick_threshold: z.number().int().nonnegative().default(64),
      /** Index file path relative to data_dir. */
      index_db: z.string().default("recall.sqlite"),
      /** Max characters per indexed text. Long messages get truncated. */
      max_chars: z.number().int().positive().default(4000),
      /** Min characters to bother indexing. Filter out tapbacks/reactions. */
      min_chars: z.number().int().positive().default(8),
      /** Backfill ceiling: don't index messages older than this many days
       *  on first boot. 0 = no limit. */
      backfill_days: z.number().int().nonnegative().default(365),
      /** Run a backfill pass on boot. Off in tests. */
      backfill_on_boot: z.boolean().default(true),
      /** Auto-recall: when an inbound message arrives, embed it and
       *  inject the top-N semantically similar past messages into the
       *  envelope as a "Relevant past messages" block. Saves the model
       *  from having to call `semantic_search` for the common case. */
      auto_recall_enabled: z.boolean().default(true),
      /** How many similar past messages to surface. */
      auto_recall_limit: z.number().int().positive().default(10),
      /**
       * Minimum cosine score to include a hit.
       *
       * Calibrate this against the model actually in use — the scale is not
       * comparable across embedding families. bge-small-en-v1.5 is anisotropic:
       * measured on this index, pure nonsense ("xylophone quarantine bicycle
       * tungsten") still tops out at 0.639, while genuinely relevant queries
       * reach 0.759 to 0.834. So a floor of 0.2 or 0.3 — sensible for a model
       * whose unrelated pairs sit near zero, which is where these defaults came
       * from — admits literally everything.
       *
       * 0.70 clears the nonsense band and keeps real matches. It cannot do more
       * than that: a content-free greeting scores 0.761, higher than a relevant
       * question, so no floor separates those two. That is handled before
       * scoring, by declining to search a message with no subject
       * (see memory/query-intent.ts).
       */
      auto_recall_min_score: z.number().min(-1).max(1).default(0.7),
      /** Skip messages that fall within the last N hours — those are
       *  already in the rendered recent-thread window, so re-surfacing
       *  is noise. */
      auto_recall_window_hours: z.number().int().nonnegative().default(24),
      /** Where "recent" ends and "deep" begins, in days from now.
       *  Hits older than this are shown as a separate "deep memory"
       *  envelope block, not interleaved with recent matches. */
      auto_recall_deep_split_days: z.number().int().positive().default(30),
      /** How many deep-memory hits to surface (older history). */
      auto_recall_deep_limit: z.number().int().nonnegative().default(10),
      /** Recency-boost half-life in days. Score for a hit `t` days old
       *  is `cosine * (1 + boost * exp(-t / half_life))`. Small =
       *  steep falloff; only the very recent gets boosted. */
      auto_recall_recency_half_life_days: z.number().positive().default(14),
      /** Strength of the recency boost. 0 = pure cosine; 1 = newest
       *  message gets up to 2× the score of a same-cosine older one. */
      auto_recall_recency_boost: z.number().min(0).max(5).default(1.0),
      /** Group chats only: number of hits scoped to the current
       *  inbound sender within this chat, rendered as a separate
       *  envelope block ("what <sender> has said before in this
       *  chat"). 0 disables the block. */
      auto_recall_sender_limit: z.number().int().nonnegative().default(6),
      /** MMR (maximal marginal relevance) lambda for diversity in the
       *  returned hit list. 1.0 = pure relevance (may return 10 near-
       *  duplicates that all look like the query); lower values
       *  diversify. 0.7 is a reasonable default: still prioritizes
       *  relevance but cuts the obvious clones. */
      auto_recall_mmr_lambda: z.number().min(0).max(1).default(0.7),
      /** Hard de-duplication threshold. Hits whose pairwise cosine
       *  with an already-picked hit exceeds this drop out of the
       *  results entirely. Same wording with a typo → identical
       *  vector → near-1 cosine → 0.95 drops it. Set above 1 to
       *  disable. */
      auto_recall_dedup_threshold: z.number().min(-1).max(2).default(0.95),
      /** Boost for hits older than the model's compact boundary. When
       *  set, messages older than `last_compact_at_ms` (i.e. outside
       *  the model's directly-readable context, available only via
       *  the compaction summary) get a multiplicative bonus to their
       *  rank score. 1.0 ≈ up to 2× the equivalent post-compact hit.
       *  0 = disabled. */
      auto_recall_outside_context_boost: z.number().min(0).max(5).default(1.5),
      /**
       * Suggest a skill in the envelope when the inbound semantically matches
       * one. OFF, because it was measured and it does not work yet.
       *
       * Against seven realistic probes with the configured embedder
       * (Xenova/bge-small-en-v1.5, 384d, hybrid dense+BM25), only 2 of 5 real
       * intents matched the right skill, and the errors were CONFIDENT:
       *
       *   "shareable page for this report"  -> summarize   (want instant-share)
       *   "is it going to storm tonight"    -> reminders   (want radaromega)
       *   "text my roommate, sound like me" -> reminders   (want ghostwrite-*)
       *   "thanks!"                         -> gifgrep     (want nothing)
       *
       * Neither an absolute threshold nor a first-to-second margin separates
       * right from wrong: a wrong hit scored 0.713 while a right one scored
       * 0.659, and a right hit had a 0.015 margin while a wrong one had
       * 0.129. Sending the model to read the wrong 3k-token playbook is worse
       * than the gap this was meant to close.
       *
       * The indexing and the envelope block are kept and tested, so this is
       * one flag away once the retrieval is good enough — a stronger embedder,
       * or authored "use this when…" trigger text per skill rather than
       * matching against a description written for a human to read.
       */
      suggest_skills: z.boolean().default(false),
    })
    .default({}),
  /**
   * Smart mirror — a Raspberry Pi behind a one-way mirror running the
   * constellation "mirror" variant. The daemon connects OUT to the Pi's
   * mirror bridge WebSocket; voice turns run through a dedicated
   * `mirror:pi-4` session; widget state is durable here in mirror.db and
   * pushed to the Pi on every (re)connect. All keys/intelligence stay on
   * this Mac — the Pi is only a display + microphone.
   */
  /** `[mirror]` — owned by integrations/mirror/config.ts. */
  mirror: z.unknown().optional(),
  /**
   * The skill curator — a slow background pass that looks across ALL
   * conversations for a job that keeps recurring in unrelated rooms, and
   * writes a "curated" skill for it.
   *
   * Every number here exists to keep it quiet. Producing nothing is the
   * normal outcome; a catalogue full of mediocre auto-written skills is
   * worse than a small one, because the model reads it to decide what it
   * can do.
   */
  /**
   * Announcements — telling people about a new capability, inside a
   * conversation they were already having.
   *
   * Nothing here sends a message. When an eligible person writes in, a short
   * block is added to that turn and the model may work it in if there is a
   * natural opening; if there isn't, nothing is said. What this config
   * governs is WHO gets the chance and HOW OFTEN.
   *
   * The engagement floor was set from the measured distribution, not picked.
   * Over the 30 days to 2026-08-29, of 29 people who wrote in: 7 were active
   * on >=20 days, 11 on >=12 days, and 11 on <=3 days. Twelve leaves clear
   * air on both sides and excludes the once-a-fortnight texter outright,
   * which is the case this must never get wrong — an unprompted pitch to
   * someone who barely texts reads as spam and cannot be taken back.
   *
   * Groups are never eligible: a group reaches whoever is in it, including
   * people who did not individually clear the bar.
   */
  announcements: z
    .object({
      enabled: z.boolean().default(true),
      /** Trailing window the engagement measure looks at. */
      window_days: z.number().int().positive().default(30),
      /** Distinct days the person must have written in, within that window.
       *  Distinct DAYS, not messages: forty messages in one afternoon is one
       *  conversation, not a habit. */
      min_active_days: z.number().int().positive().default(12),
      /** How long they must have been talking to Edmund at all, so a burst of
       *  new activity cannot qualify someone in their first week. */
      min_tenure_days: z.number().int().nonnegative().default(21),
      /** Minimum gap between one person hearing about ANY two capabilities. */
      cooldown_days: z.number().int().positive().default(14),
      /** Gap before the same announcement may be offered to the same chat
       *  again after the model passed on it. */
      reoffer_cooldown_days: z.number().int().positive().default(2),
      /** Chances the model gets before the pairing is retired unmentioned. A
       *  natural opening that has not appeared in this many conversations is
       *  not going to, and continuing is nagging. */
      max_offers: z.number().int().positive().default(3),
    })
    .default({}),
  skill_curator: z
    .object({
      enabled: z.boolean().default(true),
      /** Curation is judgment, not extraction — the same distinction that
       *  made the persona consolidator want a better model than the append
       *  pass. Deciding a pattern is real and writing a procedure a stranger
       *  can follow is the expensive half. */
      model: z.string().default("claude-sonnet-5"),
      /** Hours between passes. Daily: patterns emerge over weeks, and a
       *  faster clock only buys more chances to write something marginal. */
      min_interval_hours: z.number().int().positive().default(24),
      /** How far back each pass looks for asks. */
      lookback_days: z.number().int().positive().default(14),
      /** Ceiling on curated skills in the catalogue at once. Reaching it
       *  stops the pass entirely rather than evicting anything — deciding
       *  which auto-written skill to delete is a judgment nobody asked
       *  this pass to make. */
      max_curated_skills: z.number().int().positive().default(12),
      /** A curated skill nobody has read in this many days is retired. The
       *  curator only ever adds; without this the catalogue is a ratchet. */
      retire_unused_after_days: z.number().int().positive().default(30),
      /** Reads before a curated skill is worth spending a review call on. */
      review_after_reads: z.number().int().positive().default(3),
      /** Minimum gap between reviews of the same skill. */
      review_interval_days: z.number().int().positive().default(14),
    })
    .default({}),
  /**
   * Published skills — a person offering their own authored skill to
   * everyone else who talks to Edmund.
   */
  public_skills: z
    .object({
      enabled: z.boolean().default(true),
      /** Where per-conversation consent is persisted (relative to data_dir).
       *  Separate from installed-skills.json: consent is about readers, the
       *  install db is about skills, and one is rewritten far more often. */
      consent_db: z.string().default("skill-consent.json"),
    })
    .default({}),
  skills_marketplace: z
    .object({
      enabled: z.boolean().default(true),
      /** Allowlisted "owner/repo" sources. Add your own org to publish. */
      allowed_sources: z
        .array(z.string())
        .default(["anthropics/skills", "edmund-harness/edmund-skills"]),
      /** Where installed skill state is persisted (relative to data_dir). */
      installed_db: z.string().default("installed-skills.json"),
      /** Require operator approval before first use of any skill that
       *  ships scripts/ or executable content. Strongly recommended. */
      require_approval_for_scripts: z.boolean().default(true),
      /** HTTP timeout for registry + skill fetches. */
      fetch_timeout_seconds: z.number().int().positive().default(20),
    })
    .default({}),
  /**
   * Integrations (plugins). The harness core is complete without any of them;
   * each lives in its own package under `integrations/<name>/` with a
   * `manifest.yaml` declaring its tools, instructions, access rules, and
   * daemon runtime.
   *
   * `config_file` points at the operator-owned store that says which installed
   * integrations this deployment actually runs. Per-integration settings stay
   * in their own `config.toml` sections (e.g. [trading], [mirror]) — the YAML
   * governs presence and access, not tuning.
   */
  integrations: z
    .object({
      enabled: z.boolean().default(true),
      /** Directory scanned for integration packages, relative to repo root. */
      dir: z.string().default("./integrations"),
      /** Operator store of which integrations run here + access overrides. */
      config_file: z.string().default("./integrations/integrations-config.yaml"),
    })
    .default({}),
  instant_share: z
    .object({
      /** Admin password for the share server's /admin panel. Injected into the
       *  server env as INSTANT_SHARE_ADMIN_PASSWORD. Blank = admin login
       *  disabled. Keep the real value in the gitignored config.toml only. */
      admin_password: z.string().default(""),
      /** Default tunnel lifetime (minutes) for share.sh. */
      expire_minutes: z.number().int().positive().default(120),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Contact = z.infer<typeof ContactSchema>;

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function loadConfig(path = "./config.toml"): Config {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`config not found at ${resolved} — copy config.example.toml to config.toml`);
  }
  const raw = parseToml(readFileSync(resolved, "utf8")) as unknown;
  const parsed = ConfigSchema.parse(raw);
  parsed.paths.chat_db = expandHome(parsed.paths.chat_db);
  parsed.paths.data_dir = expandHome(parsed.paths.data_dir);
  validateGuestCampaignContexts(parsed, dirname(resolved));
  return parsed;
}

/**
 * Fail the boot, not the first guest turn: every campaign's context file must
 * exist and be readable at load time. Relative paths resolve against the
 * config file's directory — NOT cwd, which for MCP subprocesses is the
 * per-session sandbox — and are rewritten absolute so every later reader
 * agrees on the file. Separate from the zod schema so tests can build
 * configs without touching the filesystem; loadConfig always runs it.
 */
export function validateGuestCampaignContexts(config: Config, baseDir: string): void {
  for (const c of config.guest_campaigns) {
    const contextPath = c.context.startsWith("~")
      ? expandHome(c.context)
      : resolve(baseDir, c.context);
    try {
      readFileSync(contextPath, "utf8");
    } catch (err) {
      throw new Error(
        `guest campaign "${c.label}": context file ${contextPath} is not readable (${(err as Error).message})`,
      );
    }
    c.context = contextPath;
  }
}
