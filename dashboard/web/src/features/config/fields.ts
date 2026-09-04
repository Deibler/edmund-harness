/**
 * Declarative field descriptors for every TOML section. Mirrors the Zod
 * schema in src/config/config.ts. Used by SectionForm to render the right
 * input (password, number, textarea, enum) for each key without writing a
 * component per section.
 *
 * Section.path supports nested config locations: a section with
 * `path: "claude.pool"` reads/writes the object at `config.claude.pool`,
 * while `section.key` remains the unique tab id.
 */

export type FieldKind = "text" | "password" | "number" | "bool" | "textarea" | "enum" | "list";

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  help?: string;
};

export type Section = {
  /** Unique tab id. Must be unique across SECTIONS. */
  key: string;
  /** Optional dotted config path; defaults to `key`. Use for nested objects
   *  like `claude.pool`. */
  path?: string;
  label: string;
  description?: string;
  fields: Field[];
};

export const SECTIONS: Section[] = [
  // ===== Claude runtime =====
  {
    key: "claude",
    label: "Claude",
    description: "Model and runtime settings for the `claude` CLI.",
    fields: [
      { key: "model", label: "Model", kind: "text" },
      { key: "timeout_seconds", label: "Timeout (seconds)", kind: "number" },
      {
        key: "effort",
        label: "Effort",
        kind: "enum",
        options: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
  },
  {
    key: "claude_pool",
    path: "claude.pool",
    label: "Claude pool",
    description:
      "Resident `claude -p` worker pool — keep warm subprocesses across turns to avoid cold-spawn cost.",
    fields: [
      { key: "enabled", label: "Pool enabled", kind: "bool" },
      { key: "max_workers", label: "Max workers", kind: "number" },
      { key: "idle_evict_ms", label: "Idle evict (ms)", kind: "number" },
    ],
  },
  {
    key: "claude_auto_compact",
    path: "claude.auto_compact",
    label: "Claude auto-compact",
    description: "Preventive `/compact` injection when a session crosses the token budget.",
    fields: [
      { key: "enabled", label: "Auto-compact enabled", kind: "bool" },
      { key: "threshold_tokens", label: "Threshold (tokens)", kind: "number" },
    ],
  },
  {
    key: "resources",
    label: "Resources",
    description:
      "Memory monitoring and bounded cleanup for the daemon and its managed worker process groups.",
    fields: [
      { key: "memory_soft_mb", label: "Memory soft limit (MiB)", kind: "number" },
      { key: "memory_hard_mb", label: "Memory hard limit (MiB)", kind: "number" },
      { key: "sample_seconds", label: "Sample interval (seconds)", kind: "number" },
      { key: "sustained_samples", label: "Hard-limit samples", kind: "number" },
      { key: "restart_on_hard_limit", label: "Restart on sustained hard limit", kind: "bool" },
    ],
  },

  // ===== Behavior =====
  {
    key: "behavior",
    label: "Behavior",
    description: "Debounce, history, session idle, typing, threading, and chunking.",
    fields: [
      { key: "chunk_chars", label: "Chunk size (chars)", kind: "number" },
      { key: "debounce_ms", label: "Debounce (ms)", kind: "number" },
      { key: "debounce_max_ms", label: "Debounce max (ms)", kind: "number" },
      {
        key: "attachment_debounce_ms",
        label: "Captioned attachment debounce (ms)",
        kind: "number",
      },
      {
        key: "bare_attachment_debounce_ms",
        label: "Bare attachment debounce (ms)",
        kind: "number",
        help: "How long to wait for a caption after a media-only message before replying.",
      },
      {
        key: "coalesce_pending",
        label: "Coalesce mid-turn messages",
        kind: "bool",
        help: "Fold messages arriving mid-turn into the current reply instead of queueing a new turn.",
      },
      { key: "reply_threading", label: "Reply threading", kind: "bool" },
      { key: "history_messages", label: "Cold-start history (messages)", kind: "number" },
      { key: "history_always", label: "Inject history every turn", kind: "bool" },
      { key: "participant_roster", label: "Participant roster in groups", kind: "bool" },
      { key: "session_idle_hours", label: "Session idle hours", kind: "number" },
      { key: "transcribe_inbound_audio", label: "Transcribe inbound audio", kind: "bool" },
      { key: "auto_typing", label: "Auto typing indicator", kind: "bool" },
      { key: "auto_typing_seconds", label: "Auto-typing duration (s)", kind: "number" },
      {
        key: "thread_break_minutes",
        label: "Thread-break minutes",
        kind: "number",
        help: "Silence beyond this counts as a new thread for history segmentation.",
      },
      {
        key: "topic_shift_minutes",
        label: "Topic-shift minutes",
        kind: "number",
        help: "Pause within a thread that signals a new topic.",
      },
      { key: "history_max_per_segment", label: "History max per segment", kind: "number" },
      { key: "history_candidate_window", label: "History candidate window", kind: "number" },
      {
        key: "separate_group_prompts",
        label: "Separate group/DM venue prompts",
        kind: "bool",
        help: "Load persona/VENUE_GROUP.md and VENUE_DM.md (editable) instead of in-code defaults.",
      },
      {
        key: "auto_catchup_threshold",
        label: "Auto-catchup threshold (msgs)",
        kind: "number",
        help: "Unread count past which catch_me_up runs before reply.",
      },
    ],
  },

  // ===== iMessage subsystem =====
  {
    key: "imessage_watcher",
    label: "iMessage watcher",
    description: "Source the daemon uses to wake on new chat.db rows.",
    fields: [
      {
        key: "source",
        label: "Watcher source",
        kind: "enum",
        options: ["auto", "imsg", "fs"],
        help: "`auto` tries imsg (sub-100ms latency, needs the `imsg` CLI) then falls back to fs.watch.",
      },
    ],
  },
  {
    key: "imessage_send",
    label: "iMessage send",
    description: "Path used to deliver outbound messages and retry behavior.",
    fields: [
      {
        key: "path",
        label: "Send path",
        kind: "enum",
        options: ["auto", "bridge", "legacy", "applescript"],
        help: "`auto` = bridge if up else legacy; `bridge` = fail loud if IMCore bridge isn't live.",
      },
      { key: "retry_attempts", label: "Retry attempts", kind: "number" },
      { key: "retry_max_ms", label: "Retry max wall-time (ms)", kind: "number" },
    ],
  },
  {
    key: "imessage_actions",
    label: "iMessage actions",
    description:
      "What the model is allowed to do to messages / groups. These are security-relevant; off-by-default for the destructive ones.",
    fields: [
      { key: "effects", label: "Send effects (slam, loud, etc.)", kind: "bool" },
      { key: "subject_lines", label: "Subject lines", kind: "bool" },
      { key: "edit_messages", label: "Edit own messages", kind: "bool" },
      { key: "unsend_messages", label: "Unsend own messages", kind: "bool" },
      { key: "delete_messages", label: "Delete local messages", kind: "bool" },
      { key: "rename_group", label: "Rename groups", kind: "bool" },
      { key: "group_photo", label: "Set group photo", kind: "bool" },
      { key: "manage_members", label: "Add / remove group members", kind: "bool" },
      { key: "create_chat", label: "Create new chats", kind: "bool" },
    ],
  },
  {
    key: "outbound",
    label: "Outbound mode",
    description: "Gate on what kinds of chats the bot is allowed to send to.",
    fields: [
      {
        key: "mode",
        label: "Mode",
        kind: "enum",
        options: ["*", "dm_only", "groupchat_only"],
        help: "`*` = both. Leave blank to disable outbound entirely.",
      },
    ],
  },

  // ===== Recovery =====
  {
    key: "recovery",
    label: "Recovery sweeper",
    description:
      "Background sweep that revives sessions where the user spoke but the bot never replied (crashes, bridge wedges).",
    fields: [
      { key: "enabled", label: "Recovery enabled", kind: "bool" },
      { key: "sweep_interval_seconds", label: "Sweep interval (s)", kind: "number" },
      {
        key: "stale_threshold_seconds",
        label: "Stale threshold (s)",
        kind: "number",
        help: "How long after an unanswered inbound before the sweeper considers a session stuck.",
      },
      {
        key: "cooldown_minutes",
        label: "Per-session cooldown (min)",
        kind: "number",
        help: "Spacing between recovery attempts for the same session.",
      },
      {
        key: "max_heal_failures_before_alert",
        label: "Max heal failures before alert",
        kind: "number",
      },
      {
        key: "max_age_hours",
        label: "Max age alert threshold (h)",
        kind: "number",
        help: "Past this age, the sweeper still tries but also fires an operator alert.",
      },
    ],
  },

  // ===== Brown-nose / ghost =====
  {
    key: "brown_nose",
    label: "Brown-nose",
    description: "Proactive outreach engine — ghost decides whether to ping a chat unprompted.",
    fields: [
      { key: "enabled", label: "Brown-nose enabled", kind: "bool" },
      {
        key: "intensity",
        label: "Intensity (1-10)",
        kind: "number",
        help: "Higher = more frequent + larger weekly cap.",
      },
      { key: "dms_enabled_by_default", label: "Auto-enroll new DMs", kind: "bool" },
      { key: "groups_enabled_by_default", label: "Auto-enroll new groups", kind: "bool" },
      { key: "ghost_model", label: "Ghost model", kind: "text" },
      { key: "default_timezone", label: "Default timezone", kind: "text" },
      { key: "max_ghost_ticks_per_day", label: "Max ghost ticks / chat / day", kind: "number" },
      { key: "max_concurrent_fires", label: "Max concurrent fires (global)", kind: "number" },
      { key: "min_seconds_between_fires", label: "Min seconds between fires", kind: "number" },
      { key: "schedule_jitter_min_minutes", label: "Schedule jitter min (min)", kind: "number" },
      { key: "schedule_jitter_max_minutes", label: "Schedule jitter max (min)", kind: "number" },
      { key: "fire_defer_min_minutes", label: "Defer min when capped (min)", kind: "number" },
      { key: "fire_defer_max_minutes", label: "Defer max when capped (min)", kind: "number" },
    ],
  },

  // ===== People maintainer =====
  {
    key: "people_maintainer",
    label: "People maintainer",
    description:
      "Background Haiku pass that keeps persona/people/<handle>.md and persona/groups/<slug>.md current.",
    fields: [
      { key: "enabled", label: "Maintainer enabled", kind: "bool" },
      { key: "model", label: "Model", kind: "text" },
      { key: "min_interval_minutes", label: "Min interval per session (min)", kind: "number" },
      { key: "recent_messages", label: "Recent messages window", kind: "number" },
      {
        key: "dry_run",
        label: "Dry-run mode",
        kind: "bool",
        help: "Log proposed updates without writing.",
      },
    ],
  },

  // ===== Memory recall =====
  {
    key: "memory_recall",
    label: "Recall (index)",
    description:
      "Embedding index over iMessage history. Backs `semantic_search` and the auto-recall envelope block.",
    fields: [
      { key: "enabled", label: "Recall enabled", kind: "bool" },
      {
        key: "provider",
        label: "Provider",
        kind: "enum",
        options: ["transformers", "ollama", "openai"],
      },
      { key: "model", label: "Embedding model", kind: "text" },
      { key: "dim", label: "Embedding dim", kind: "number" },
      { key: "ollama_endpoint", label: "Ollama endpoint", kind: "text" },
      { key: "batch_size", label: "Batch size", kind: "number" },
      { key: "chunk_size", label: "Chunk size (chars)", kind: "number" },
      { key: "adaptive_retick_threshold", label: "Adaptive retick threshold", kind: "number" },
      { key: "index_db", label: "Index DB filename", kind: "text" },
      { key: "max_chars", label: "Max chars per row", kind: "number" },
      { key: "min_chars", label: "Min chars per row", kind: "number" },
      { key: "backfill_days", label: "Backfill window (days)", kind: "number" },
      { key: "backfill_on_boot", label: "Backfill on boot", kind: "bool" },
    ],
  },
  {
    key: "memory_recall_auto",
    path: "memory_recall",
    label: "Recall (auto-recall)",
    description:
      "Per-turn injection of similar past messages into the envelope as a 'Relevant past messages' block.",
    fields: [
      { key: "auto_recall_enabled", label: "Auto-recall enabled", kind: "bool" },
      { key: "auto_recall_limit", label: "Recent-window limit", kind: "number" },
      { key: "auto_recall_min_score", label: "Min cosine score", kind: "number" },
      { key: "auto_recall_window_hours", label: "Recent window (hours)", kind: "number" },
      { key: "auto_recall_deep_split_days", label: "Deep split (days)", kind: "number" },
      { key: "auto_recall_deep_limit", label: "Deep limit", kind: "number" },
      {
        key: "auto_recall_recency_half_life_days",
        label: "Recency half-life (days)",
        kind: "number",
      },
      { key: "auto_recall_recency_boost", label: "Recency boost (0-5)", kind: "number" },
      { key: "auto_recall_sender_limit", label: "Per-sender cap", kind: "number" },
      {
        key: "auto_recall_mmr_lambda",
        label: "MMR lambda (0-1)",
        kind: "number",
        help: "1=pure relevance, 0=pure diversity.",
      },
      { key: "auto_recall_dedup_threshold", label: "Dedup threshold", kind: "number" },
      {
        key: "auto_recall_outside_context_boost",
        label: "Outside-context boost",
        kind: "number",
      },
    ],
  },

  // ===== Skills marketplace =====
  {
    key: "skills_marketplace",
    label: "Skills marketplace",
    description: "Source allowlist + safety gates for installable skills.",
    fields: [
      { key: "enabled", label: "Marketplace enabled", kind: "bool" },
      { key: "allowed_sources", label: "Allowed sources (one per line)", kind: "list" },
      { key: "installed_db", label: "Installed-skills DB filename", kind: "text" },
      {
        key: "require_approval_for_scripts",
        label: "Require approval for skills with scripts",
        kind: "bool",
      },
      { key: "fetch_timeout_seconds", label: "Fetch timeout (s)", kind: "number" },
    ],
  },

  // ===== External services =====
  {
    key: "cloudflare",
    label: "Cloudflare",
    description: "Account creds for the Cloudflare Browser Run `cf_*` tools.",
    fields: [
      { key: "account_id", label: "Account ID", kind: "text" },
      { key: "api_token", label: "API token", kind: "password" },
    ],
  },

  // ===== Operator alerts =====
  {
    key: "alerts",
    label: "Operator alerts",
    description:
      "Raw iMessages sent when the bot is broken (auth, runner crash, repeated heal failure).",
    fields: [
      { key: "operator_handle", label: "Operator handle", kind: "text" },
      { key: "min_interval_minutes", label: "Min interval (min)", kind: "number" },
    ],
  },

  // ===== Dashboard self-config =====
  {
    key: "dashboard",
    label: "Dashboard",
    description: "This UI's own settings. pin_hash is set via `dashboard:set-pin` CLI.",
    fields: [
      { key: "port", label: "Port", kind: "number" },
      {
        key: "bind",
        label: "Bind",
        kind: "text",
        help: "0.0.0.0 = LAN; 127.0.0.1 = localhost only",
      },
      { key: "session_days", label: "Login session (days)", kind: "number" },
      {
        key: "external_url",
        label: "External URL",
        kind: "text",
        help: "Public base URL for annotation links (e.g. https://dash.example.com).",
      },
    ],
  },

  // ===== Tools defaults =====
  {
    key: "tools",
    label: "Tools",
    description: "Image/TTS/STT defaults.",
    fields: [
      {
        key: "image_provider",
        label: "Image provider",
        kind: "enum",
        options: ["openai", "gemini"],
      },
      { key: "image_model", label: "Image model", kind: "text" },
      { key: "tts_voice", label: "TTS voice", kind: "text" },
      { key: "stt_model", label: "STT model", kind: "text" },
    ],
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    description: "Generation caps and default models.",
    fields: [
      { key: "max_image_price_usd", label: "Max image price (USD)", kind: "number" },
      { key: "max_video_price_per_second_usd", label: "Max video $/sec", kind: "number" },
      { key: "max_audio_price_usd", label: "Max audio price (USD)", kind: "number" },
      { key: "default_image_model", label: "Default image model", kind: "text" },
      { key: "default_edit_model", label: "Default edit model", kind: "text" },
      { key: "default_video_model", label: "Default video model", kind: "text" },
      { key: "default_audio_model", label: "Default audio model", kind: "text" },
      { key: "default_audio_voice", label: "Default audio voice", kind: "text" },
      { key: "video_poll_interval_s", label: "Video poll interval (s)", kind: "number" },
      { key: "video_max_wait_s", label: "Video max wait (s)", kind: "number" },
    ],
  },

  // ===== Generation credits =====
  {
    key: "credits",
    label: "Generation credits",
    description:
      "Per-person prepaid wallets for images, videos and audio. Who is on which key is edited on the Credits page (Ops).",
    fields: [
      { key: "enabled", label: "Enabled", kind: "bool" },
      {
        key: "starter_usd",
        label: "Starter credit (USD)",
        kind: "number",
        help: "Free credit on first use. 0 = the first request refuses and sends the top-up link.",
      },
      {
        key: "low_watermark_usd",
        label: "Low-credit nudge under (USD)",
        kind: "number",
      },
      {
        key: "credit_ratio",
        label: "Credit per $1 paid",
        kind: "number",
        help: "0.90 absorbs about a cent on the dollar after Stripe and OpenRouter fees; 0.87 is neutral.",
      },
      { key: "min_topup_usd", label: "Minimum top-up (USD)", kind: "number" },
      { key: "max_topup_usd", label: "Maximum top-up (USD)", kind: "number" },
      { key: "presets_usd", label: "Preset buttons (USD)", kind: "list" },
      { key: "product_name", label: "Checkout line-item name", kind: "text" },
      {
        key: "stripe_product_id",
        label: "Stripe product id",
        kind: "text",
        help: "prod_… every top-up rolls up under in Stripe. Empty = inline by name.",
      },
      {
        key: "stripe_tax_code",
        label: "Stripe tax code",
        kind: "text",
        help: "txcd_… for the inline product. Managed Payments refuses a product without one.",
      },
    ],
  },
  // ===== Keys =====
  {
    key: "keys",
    label: "API keys",
    description:
      "Shown masked; submit to overwrite. Leave a value with • to keep the existing one.",
    fields: [
      { key: "openai", label: "OpenAI", kind: "password" },
      { key: "gemini", label: "Gemini", kind: "password" },
      { key: "elevenlabs", label: "ElevenLabs", kind: "password" },
      { key: "openrouter", label: "OpenRouter", kind: "password" },
      {
        key: "openrouter_provisioning",
        label: "OpenRouter management key",
        kind: "password",
        help: "Formerly 'provisioning'. Mints per-person keys for generation credits. Cannot run models.",
      },
      {
        key: "stripe_secret",
        label: "Stripe secret",
        kind: "password",
        help: "sk_live_… / sk_test_… — creates Checkout Sessions for credit top-ups.",
      },
      {
        key: "stripe_publishable",
        label: "Stripe publishable",
        kind: "password",
        help: "pk_… — not used by the hosted checkout; kept for a future embedded form.",
      },
      {
        key: "stripe_webhook_secret",
        label: "Stripe webhook secret",
        kind: "password",
        help: "whsec_… for the endpoint at <external_url>/pay/stripe. Unset rejects every webhook.",
      },
      {
        key: "brave",
        label: "Brave Search",
        kind: "password",
        help: "Enables the `web_search` MCP tool.",
      },
    ],
  },

  // ===== Identity / allowlist =====
  {
    key: "identity",
    label: "Identity",
    description: "Names the bot answers to (case-insensitive, word-boundary match).",
    fields: [{ key: "names", label: "Names (one per line)", kind: "list" }],
  },
  {
    key: "self",
    label: "Self",
    description: "Your own iMessage handles (used to ignore your own outbound messages).",
    fields: [{ key: "handles", label: "Handles (one per line)", kind: "list" }],
  },
  {
    key: "allowlist",
    label: "Allowlist",
    description: "Empty = allow everyone. Otherwise, only these handles / GUIDs get responses.",
    fields: [
      { key: "dm", label: "DM handles (one per line)", kind: "list" },
      { key: "groups", label: "Group GUIDs (one per line)", kind: "list" },
    ],
  },
  {
    key: "paths",
    label: "Paths",
    fields: [
      { key: "chat_db", label: "chat.db path", kind: "text" },
      { key: "data_dir", label: "Data dir", kind: "text" },
    ],
  },
];
