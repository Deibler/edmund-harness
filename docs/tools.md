# Tools the model can call

Every turn runs with an MCP server (`src/mcp/server.ts`) that registers the
tools below. The set depends on who is talking. The operator gets all of it.
An allowlisted contact, under the default `[security].contact_tier`, loses the
tools that reach other people or the global memory: the contact list, relays
and errands, `remember_about_self`, `update_self_memory`,
`remember_about_subject`, `memory_search`, and skill publishing or
installing; `semantic_search` also refuses the cross chat scopes. Guests get a
conversational subset with no memory, history, filesystem, scheduling or
integrations. Sub-agents lose the tools that would let them spawn more agents. Integrations add their own tools by
manifest and never for guests.

There are 91 core tools. This page groups them; the source files under
`src/mcp/tools/` are the reference for arguments.

## Messaging in the current chat

| Tool | What it does |
|---|---|
| `send_message` | Send a bubble now, mid turn, instead of waiting for the final reply |
| `send_attachment` | Send a file; images are resized and videos transcoded first |
| `send_location` | Send an Apple Maps card for an address or coordinates |
| `react` | Add a tapback to a message |
| `check_incoming` | Peek at messages that arrived while this turn was running |
| `activate_typing` | Show the typing indicator |

## iMessage actions

`edit_message`, `unsend_message`, `delete_message`, `rename_group`,
`set_group_photo`, `add_group_member`, `remove_group_member`, `leave_group`,
`create_chat`. Group operations only register inside a group.

## Other people and other chats

| Tool | What it does |
|---|---|
| `list_contacts` | Names and handles from Contacts plus configured aliases |
| `message_contact` | Relay a message into another person's session. Depth is capped at three so relays cannot chain forever, and media is staged into the recipient's sandbox |
| `ask_contact`, `report_errand`, `list_errands`, `cancel_errand` | A relay that expects an answer back, tracked in `errands.db` |

## History and recall

| Tool | What it does |
|---|---|
| `search_history`, `get_message`, `get_thread_context` | Query `chat.db` for this conversation |
| `catch_me_up` | Summarise what happened in a thread; the recap is stored for recall |
| `list_attachments` | Attachments in this conversation |
| `semantic_search`, `memory_search` | Query the recall index |

## Memory

`remember_about_person`, `read_person_file`, `write_person_file`,
`remember_about_subject`, `remember_about_self`, `read_self_memory`,
`update_self_memory`. See [memory.md](memory.md).

## Generation and media

| Tool | What it does |
|---|---|
| `generate_image`, `generate_video`, `generate_audio` | Generate through OpenRouter and deliver the result to the chat |
| `list_image_models`, `list_video_models`, `list_audio_models` | What is available |
| `model_scorecard`, `rate_model_output` | Track which models produce good results |
| `transcribe_audio` | Speech to text for a voice memo |
| `analyze_video` | Describe a video |
| `request_image_annotation` | Hand the person a link where they can mark up an image |

Every generation goes through the credits layer. If the person's wallet
cannot cover it, the tool refuses with a message the model relays along with a
link to top up. See [generation-credits.md](generation-credits.md).

## Web

`web_search` (Brave), `web_fetch` (with an SSRF guard that refuses private
addresses), `check_bg_job`, `list_bg_jobs` for long running fetches.

## Scheduling and proactive behaviour

| Tool | What it does |
|---|---|
| `schedule_reminder`, `update_reminder`, `list_reminders`, `cancel_reminder` | Cron jobs that wake this session with a scheduled event |
| `poke` | Wake this session again in 10 to 300 seconds |
| `set_trigger`, `list_triggers`, `cancel_trigger` | A probe and a predicate the daemon evaluates without the model; fires only on a real change |
| `start_mission`, `list_missions`, `end_mission` | A recurring job with a brief and a notes file whose routine checks stay silent |
| `set_brown_nose`, `enable_brown_nose`, `disable_brown_nose` | Per-person proactive outreach settings |
| `add_focus_suggestion`, `clear_focus_suggestions`, `query_ghost`, `ghost_status` | Steer and inspect the proactive observer |
| `get_portal_link` | A link to the person's own portal |

See [proactive.md](proactive.md).

## Agents and research

| Tool | What it does |
|---|---|
| `spawn_agent`, `check_agent`, `list_agents`, `read_agent_result`, `cancel_agent` | Detached sub-agents that work in the session's sandbox and report back |
| `handoff_current_work` | Hand the current task to a fresh agent |
| `spawn_team`, `list_team`, `read_team_results`, `cancel_team` | Several agents on one question |
| `deep_research` | Plan sub-queries, fan out researchers, synthesise when the last one finishes |

## Skills

| Tool | What it does |
|---|---|
| `list_skills`, `read_skill` | Discover and read a skill. A public skill's body is withheld until the person has consented to its use |
| `create_skill`, `update_skill`, `publish_skill`, `unpublish_skill` | The model can write skills for itself |
| `confirm_skill_use` | Refused unless a human turn arrived after the consent question was asked |
| `search_marketplace`, `install_skill`, `uninstall_skill`, `list_installed_skills` | Skills from a registry |

See [skills.md](skills.md).

## The gates every tool passes

- **Path safety**: `assertPathSafe` refuses paths under `~/.ssh`, keychains,
  `state.db` and `config.toml`, and anything outside the session's sandbox
  or the data directory.
- **Send verification**: the same post-send check the daemon runs also runs
  inside the MCP process, and a registry heal is requested over the control
  socket rather than performed locally.
- **Stdout protection**: the console is redirected to stderr before anything
  else loads, because stdout is the JSON-RPC stream.
- **Schema hygiene**: zod errors are reformatted with the expected fields, and
  common argument aliases are normalised. A zod type the MCP SDK cannot
  publish would produce an empty schema and a model that guesses; the test
  suite pins the published schemas for that reason.
