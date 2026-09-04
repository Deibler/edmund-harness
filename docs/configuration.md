# Configuration reference

`config.toml` is read once at daemon start (the dashboard re-reads it with a
short cache). Copy `config.example.toml` to get every section with comments.
Values below are the schema defaults from `src/config/config.ts`; where the
example file ships a different value, the example wins on a fresh install and
is noted.

Paths under `[paths]` expand `~`. Guest campaign context files must exist at
boot or the daemon refuses to start. Unknown keys are ignored.

Sections marked *opaque* belong to an integration. Core does not validate
them; the integration's own `config.ts` does, and if the integration is
deleted the section is simply unused.

## Who talks and who answers

### `[self]`

| Key | Default | Meaning |
|---|---|---|
| `handles` | `[]` | Addresses of the account the assistant sends from. Inbound from these is ignored so it never answers itself |

### `[allowlist]`

| Key | Default | Meaning |
|---|---|---|
| `dm` | `[]` | Who may DM. Empty admits nobody unless `[security].open_dm_allowlist` is on |
| `groups` | `[]` | Chat GUIDs of groups it may speak in. Empty registers none unless `[security].open_group_allowlist` is on |

### `[security]`

The trust decisions, in one place. Defaults are the safe choice for a new
install. Each line is one you may want to loosen, and each loosening is
visible in the file rather than implied by an empty list.

| Key | Default | Meaning |
|---|---|---|
| `model_host_access` | `sandboxed` | `sandboxed`: the model's built in shell and filesystem tools are disallowed for every session, Codex keeps its own sandbox, and model authored scripts (data trigger predicates, refresh scripts) do not run. `full`: bypass permissions for Claude Code, sandbox and approvals off for Codex; the model can do anything your account can |
| `contact_tier` | `contact` | What an allowlisted handle that is not an operator gets. `contact`: this conversation only, no messaging other people, no contact list, no cross chat recall, no writes to the global self memory, no publishing or installing skills. `operator`: everything |
| `operator_handles` | `[]` | Who is the operator. Empty falls back to `[alerts].operator_handle` |
| `open_dm_allowlist` | `false` | With `[allowlist].dm` empty, admit everyone who can reach the number |
| `open_group_allowlist` | `false` | With `[allowlist].groups` empty, answer in any group that mentions the assistant |

Groups are always the contact tier under `contact`, because the sender of a
group message is not known inside tool processes. The operator's own
surfaces (mirror, trading, sub-agents) are always the operator tier.

### `[identity]`

| Key | Default | Meaning |
|---|---|---|
| `names` | `["claude"]` | How it is addressed in groups. `IDENTITY.md` should use one of these |

### `[owner]`

| Key | Default | Meaning |
|---|---|---|
| `name` | `""` | The operator's name, used in the prompt as "an AI that <name> built". Blank falls back to "your operator" |

### `[[contacts]]`

Repeatable. `name` (optional) and `handles` (at least one). Merges a person's
phone and email into a single session.

### `[[orchestrators]]`

Repeatable. Extra named personas with their own session namespace and persona
overrides under `persona/orchestrators/<key>/`.

| Key | Meaning |
|---|---|
| `key` | Slug up to 32 chars, not one of the reserved names |
| `name` | Display name |
| `invocations` | Names that address it; globally unique |
| `role` | `secondary` (default) or `primary`; at most one primary |
| `model` | Override, or empty to inherit `[claude].model` |

### `[guest_access]` and `[[guest_campaigns]]`

Off by default. See [recovery.md](recovery.md) for what a guest can do.

| Key | Default | Meaning |
|---|---|---|
| `guest_access.enabled` | `false` | Admit senders who are not allowlisted, by key or by vouching |
| `key` | required | At least 8 characters, matched case insensitively, unique |
| `label` | required | Used in operator alerts |
| `context` | required | Markdown file appended to the guest's system prompt; `campaigns/example.md` is the template |
| `expires` | none | ISO date after which the key is inert and replies stop |
| `max_spend_usd` | none | Lifetime cap through the spend ledger |
| `max_messages_per_day` | none | Daily cap |

## The model

### `[claude]`

Applies to both providers despite the name.

| Key | Default | Meaning |
|---|---|---|
| `model` | `claude-opus-4-8[1m]` | `gpt-*`, `o*`, `chatgpt-*`, `codex-*` select Codex CLI; anything else selects Claude Code |
| `timeout_seconds` | `180` | Per turn |
| `effort` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `context_window_tokens` | unset | Codex only. Leave unset so the CLI uses its own metadata |
| `agent_model` | `claude-sonnet-5` | Model for detached sub-agents |
| `agent_effort` | unset | Effort for sub-agents |

### `[claude.pool]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Keep one resident worker process per active session |
| `max_workers` | `6` | Resident processes before eviction |
| `idle_evict_ms` | `600000` | Evict a worker idle this long |

### `[claude.auto_compact]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Compact when measured context crosses the threshold |
| `threshold_tokens` | `800000` | Measured from the provider's own token counts. See [costs.md](costs.md) before raising it |

### `[codex]`

Codex only overrides. Each falls back to `[claude]` except
`context_window_tokens`, which is deliberately not inherited.

| Key | Meaning |
|---|---|
| `effort` | Codex effort |
| `context_window_tokens` | Explicit window |
| `threshold_tokens` | Re-anchor threshold: the thread id is dropped and the next turn starts cold |

## Behaviour

### `[behavior]`

| Key | Default | Meaning |
|---|---|---|
| `chunk_chars` | `1800` | Reply chunk size; code fences stay intact |
| `debounce_ms` | `1500` | Idle window before a batch is flushed |
| `debounce_max_ms` | `10000` | Hard cap on the window |
| `attachment_debounce_ms` | `600` | Window after a captioned attachment |
| `bare_attachment_debounce_ms` | `4000` | Window after an attachment with no text |
| `voice_debounce_ms` | `250` | Window after a voice memo |
| `coalesce_pending` | `true` | Re-run a turn with messages that arrived mid turn |
| `liveness_typing_seconds` | `15` | Show typing after this long with no output |
| `durable_pending_ack` | `true` | Write the inbound ack before advancing the cursor |
| `reply_threading` | `true` | Reply to the message that was answered |
| `history_messages` | `20` | History rows on a cold start |
| `history_always` | `false` | Include history on every turn, not just cold starts |
| `participant_roster` | `true` | List participants in group envelopes |
| `session_idle_hours` | `72` | Idle longer than this is a cold start |
| `transcribe_inbound_audio` | `true` | Speech to text on voice memos |
| `auto_typing` | `true` | Typing indicator while the model works |
| `auto_typing_seconds` | `30` | Refresh interval, 5 to 120 |
| `thread_break_minutes` | `30` | Gap that segments history |
| `topic_shift_minutes` | `5` | Gap that marks a topic shift |
| `history_max_per_segment` | `30` | Rows per segment |
| `history_candidate_window` | `80` | Rows considered when building segments |
| `separate_group_prompts` | `true` | Groups get their own venue prompt |
| `auto_catchup_threshold` | `25` | Unanswered rows that trigger a catch-up summary |
| `catchup_on_boot` | `true` | Answer the backlog before the live watcher starts |
| `catchup_concurrency` | `3` | Sessions caught up at once |

### `[imessage_watcher]`

| Key | Default | Meaning |
|---|---|---|
| `source` | `auto` | `auto` or `fs`. `imsg` is accepted as an alias for `auto` |

### `[imessage_send]`

There is one transport, the injected bridge. Older versions had a `path` knob;
it no longer exists.

| Key | Default | Meaning |
|---|---|---|
| `health_interval_ms` | `30000` | Liveness probe interval, 0 disables |
| `health_timeout_ms` | `5000` | Probe timeout |
| `block_self_sends` | `true` | Refuse in process to send to the account's own handles |

### `[imessage_actions]`

Which rich actions the model may use. On by default: `effects`,
`subject_lines`, `edit_messages`, `unsend_messages`. Off by default:
`delete_messages`, `rename_group`, `group_photo`, `manage_members`,
`create_chat`.

### `[outbound]`

| Key | Default | Meaning |
|---|---|---|
| `mode` | unset | `*`, `dm_only` or `groupchat_only` for the cross session relay. Unset disables it |

### `[paths]`

| Key | Default | Meaning |
|---|---|---|
| `chat_db` | `~/Library/Messages/chat.db` | The message store |
| `data_dir` | `./data` | Everything the runtime writes. Relative to the repo; the CLI pins the working directory |

### `[resources]`

| Key | Default | Meaning |
|---|---|---|
| `memory_soft_mb` | `4096` | Above this, flush workers and trim embedding workers |
| `memory_hard_mb` | `7168` | Above this, restart if allowed |
| `sample_seconds` | `15` | Sampling interval |
| `sustained_samples` | `3` | Samples over a limit before acting |
| `restart_on_hard_limit` | `true` | SIGTERM self at the hard limit |

## Memory

### `[memory_recall]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Build and query the recall index |
| `provider` | `transformers` | `transformers` (local), `openai`, `ollama`, `none` |
| `model` | `Xenova/bge-small-en-v1.5` | Embedding model. The example ships `Xenova/all-MiniLM-L6-v2` |
| `dim` | `384` | Vector size |
| `ollama_endpoint` | `http://127.0.0.1:11434` | For the Ollama provider |
| `batch_size` | `128` | Rows embedded per batch |
| `chunk_size` | `2000` | Characters per chunk |
| `index_db` | `recall.sqlite` | File under `data_dir` |
| `max_chars`, `min_chars` | `4000`, `8` | Row length bounds |
| `backfill_days` | `365` | How far back to index at first boot |
| `backfill_on_boot` | `true` | |
| `auto_recall_enabled` | `true` | Search before each turn |
| `auto_recall_limit` | `10` | Recent hits |
| `auto_recall_min_score` | `0.7` | Similarity floor. The example ships `0.2`, which the schema comment notes admits nearly everything with the default model |
| `auto_recall_window_hours` | `24` | Hits inside this window are already in history and skipped |
| `auto_recall_deep_split_days` | `30` | Older than this counts as deep history |
| `auto_recall_deep_limit` | `10` | Deep hits |
| `auto_recall_recency_half_life_days` | `14` | Recency boost half life |
| `auto_recall_recency_boost` | `1.0` | |
| `auto_recall_sender_limit` | `6` | Sender in other chats, groups only |
| `auto_recall_mmr_lambda` | `0.7` | Diversity versus relevance |
| `auto_recall_dedup_threshold` | `0.95` | Near duplicate cutoff |
| `auto_recall_outside_context_boost` | `1.5` | Boost for rows the model can no longer see after a compaction |
| `suggest_skills` | `false` | Suggest a skill in the envelope from recall. Off because the embedder matched two of five intents and was confidently wrong |

### `[people_maintainer]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Append observations after replies. The example ships `false` |
| `model` | `claude-haiku-4-5` | The example ships `claude-sonnet-5` |
| `min_interval_minutes` | `15` | Per session floor |
| `recent_messages` | `30` | Messages the maintainer sees |
| `dry_run` | `false` | Log what would be written |

## Proactive

### `[brown_nose]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | The example ships `false`. Leave it off until you have read [proactive.md](proactive.md) |
| `intensity` | `5` | 1 to 10 |
| `dms_enabled_by_default` | `true` | New DMs are enrolled |
| `groups_enabled_by_default` | `false` | |
| `ghost_model` | `claude-opus-4-8` | The observer's model |
| `prescreen_enabled` | `true` | Cheap first pass |
| `prescreen_model` | `claude-haiku-4-5-20251001` | |
| `default_timezone` | `America/New_York` | For active hours |
| `max_ghost_ticks_per_day` | `20` | Counted from the spend ledger |
| `max_concurrent_fires` | `3` | Global semaphore |
| `schedule_jitter_min_minutes`, `schedule_jitter_max_minutes` | `0`, `35` | Randomised delay before a fire |
| `fire_defer_min_minutes`, `fire_defer_max_minutes` | `5`, `15` | Delay after a decision |
| `min_seconds_between_fires` | `90` | Spacing between proactive turns |

### `[triggers]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Evaluate model authored data triggers |
| `tick_seconds` | `60` | |

### `[announcements]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Offer capability news inside turns people are already having |
| `window_days` | `30` | Activity window |
| `min_active_days` | `12` | Distinct active days in the window to be eligible |
| `min_tenure_days` | `21` | Time since first message |
| `cooldown_days` | `14` | Between hearing about anything |
| `reoffer_cooldown_days` | `2` | Between chances at the same item |
| `max_offers` | `3` | Then the pairing is exhausted |

## Skills

### `[skill_curator]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Background curator |
| `model` | `claude-sonnet-5` | |
| `min_interval_hours` | `24` | |
| `lookback_days` | `14` | Messages sampled |
| `max_curated_skills` | `12` | Hard ceiling |
| `retire_unused_after_days` | `30` | Unread curated skills are retired |
| `review_after_reads` | `3` | Reads that trigger a review |
| `review_interval_days` | `14` | |

### `[public_skills]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Allow publishing self skills to other conversations |
| `consent_db` | `skill-consent.json` | Under `data_dir` |

### `[skills_marketplace]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | |
| `allowed_sources` | `["anthropics/skills", "edmund-harness/edmund-skills"]` | GitHub repositories installs may come from. The example lists only the first |
| `installed_db` | `installed-skills.json` | |
| `require_approval_for_scripts` | `true` | Installed skills with scripts are inert until approved |
| `fetch_timeout_seconds` | `20` | |

## Recovery and alerts

### `[recovery]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | |
| `sweep_interval_seconds` | `60` | |
| `stale_threshold_seconds` | `90` | Inbound newer than outbound by this much is stuck |
| `cooldown_minutes` | `30` | Between recovery attempts per session |
| `max_heal_failures_before_alert` | `3` | |
| `max_age_hours` | `24` | Older stuck sessions are left alone |
| `fallback_notice_enabled` | `true` | Send a "still on it" note |
| `fallback_notice_after_minutes` | `10` | |
| `fallback_notice_text` | `hit a snag getting back to you — still on it` | |

### `[alerts]`

| Key | Default | Meaning |
|---|---|---|
| `operator_handle` | `""` | Where operator alerts are sent. Blank logs only. Also exempts this DM from per person credits |
| `min_interval_minutes` | `30` | Dedup window per alert signature |

## Money

### `[keys]`

All default to empty, and empty disables the feature that needs the key.

| Key | Used for |
|---|---|
| `openai` | Transcription fallback, some tools |
| `gemini` | Video understanding fallback |
| `elevenlabs` | Speech |
| `openrouter` | The house generation key |
| `brave` | `web_search` |
| `openrouter_provisioning` | Minting per person keys for credits |
| `stripe_secret` | Checkout sessions |
| `stripe_publishable` | Unused today |
| `stripe_webhook_secret` | Without it every webhook is rejected |

### `[openrouter]`

| Key | Default | Meaning |
|---|---|---|
| `max_image_price_usd` | `0.2` | Refuse models above this. Example ships `0.5` |
| `max_video_price_per_second_usd` | `0.5` | |
| `max_audio_price_usd` | `0.1` | Example ships `0.5` |
| `default_image_model` | `google/gemini-3.1-flash-image-preview` | |
| `default_edit_model` | `black-forest-labs/flux.2-pro` | |
| `default_video_model` | `google/veo-3.1` | |
| `default_audio_model` | `openai/gpt-4o-audio-preview` | Example ships `openai/gpt-audio-mini` |
| `default_audio_voice` | `alloy` | |
| `video_poll_interval_s`, `video_max_wait_s` | `20`, `600` | |

### `[credits]`

Off by default. See [generation-credits.md](generation-credits.md).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `starter_usd` | `0` | Free credit for a new wallet |
| `low_watermark_usd` | `1` | Below this the model mentions the top-up link |
| `credit_ratio` | `0.9` | Credit granted per dollar paid, after fees |
| `min_topup_usd`, `max_topup_usd` | `5`, `200` | |
| `presets_usd` | `[5, 10, 20]` | Buttons on the portal |
| `product_name` | `Edmund generation credit` | Stripe line item |
| `stripe_product_id` | `""` | |
| `stripe_tax_code` | `txcd_10105001` | Required on Stripe Managed Payments |

### `[tools]`

| Key | Default | Meaning |
|---|---|---|
| `image_provider` | `openai` | `openai` or `gemini` for the legacy image path |
| `image_model` | `gpt-image-1` | |
| `tts_voice` | `nova` | |
| `stt_model` | `whisper-1` | |

## Channels and surfaces

### `[sms]`

Off by default. Twilio credentials come from the environment, not this file.
See [sms-channel.md](sms-channel.md).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `from` | unset | Your Twilio number in E.164 |
| `messaging_service_sid` | unset | Preferred over bare number sends |
| `public_base_url` | unset | Must match the webhook URL configured in Twilio exactly |
| `webhook_port` | `4790` | Loopback listener |
| `allowlist` | `[]` | Who may text |
| `allow_unknown_senders` | `false` | |
| `history_messages` | `20` | |
| `max_segments_per_message`, `max_parts` | `3`, `3` | Up to 10 |
| `normalize_to_gsm7` | `true` | |
| `carrier_handles_keywords` | `true` | STOP, START, HELP handled upstream |
| `help_text` | a default line | Reply to HELP. Set your own; the built in default names the original operator |

### `[dashboard]`

| Key | Default | Meaning |
|---|---|---|
| `port` | `4747` | Operator UI |
| `bind` | `127.0.0.1` | This Mac only. `0.0.0.0` puts a PIN gated http UI on your LAN |
| `pin_hash` | `""` | Empty refuses every login; set it with `edmund dashboard --pin` |
| `session_days` | `30` | Cookie lifetime |
| `external_url` | `""` | Public base for portal links; overrides the tunnel file and LAN address |
| `public_port` | `4749` | Loopback listener that serves only portal, payment and annotation routes |

### `[instant_share]`

| Key | Default | Meaning |
|---|---|---|
| `admin_password` | `""` | Passed to the share server |
| `expire_minutes` | `120` | Default lease |

### `[integrations]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | |
| `dir` | `./integrations` | |
| `config_file` | `./integrations/integrations-config.yaml` | Per machine enable and access overrides |

### `[evals]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Weekly persona evals and probes on persona change |
| `judge_model` | `claude-haiku-4-5-20251001` | |
| `weekly_samples` | `8` | Up to 30 |
| `probe_on_persona_change` | `true` | |
| `probe_model` | `""` | |
| `regression_threshold` | `2` | |

## Integration sections (opaque to core)

| Section | Owner | Notes |
|---|---|---|
| `[cloudflare]` | cloudflare-browser | `account_id`, `api_token` |
| `[radaromega]` | radaromega | `enabled` (example `false`), `package_path`, `cdp_port` 9222, `refresh_hours` 6 |
| `[fishing]` | fishing | `enabled` false, `api_url` |
| `[mirror]` | mirror | `enabled` false, host, port 8789, `token` required when enabled, speech settings, `session_key` |
| `[trading]` | trading | `enabled` false, `handles` empty means nobody, risk limits, broker endpoint, `allow_model_supplied_risk_inputs` false. Real money |
| `[kitchen]` | kitchen | `enabled` true, `dir`, `price_max_age_days` 21. The shipped default `dir` is an absolute path from the author's machine; set your own |

## Environment variables

`.env` is sourced by the daemon's launchd wrapper and reaches the daemon and
every child process, but not the dashboard or the other services, and not
`bun run dev` unless your shell exports it. `.env.example` lists what is
commonly set. The variables the runtime itself sets for its subprocesses
(`EDMUND_SESSION_KEY`, `EDMUND_SANDBOX_PATH`, `EDMUND_DATA_DIR` and the rest)
are not for you to set.

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN` | SMS. The auth token is required for webhook signature validation |
| `OPENROUTER_API_KEY` | Fallback for some skill scripts |
| `EDMUND_LOG_LEVEL=debug`, `DEBUG=1` | Verbose logging |
| `EDMUND_REPO` | Repository root for the CLI |
| `EDMUND_CONFIG_PATH` | Config path for subprocesses and hooks |
| `SKYSTREAM_API_HOSTS`, `SKYCAM_CAMERA_HOST` | LAN hosts for two personal skills |
| `KITCHEN_*`, `INSTANT_SHARE_*`, `FISHING_API_URL`, `CONSTELLATION_REPO` | Integration and skill specific |
