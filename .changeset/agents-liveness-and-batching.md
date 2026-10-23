---
"edmund-harness": patch
---

Sub-agents are stopped when they go quiet, not when they turn fifteen minutes old, keep what they found when stopped, and report to their parent once.

- **The reaper judges output, not age.** It stopped every agent 15 minutes after spawn. Of the 35 it reaped, the 33 with logs had all written output within the last 151 seconds (29 within the last minute), so it was killing work in progress. The runner now stamps a heartbeat on each line its CLI prints, and the reaper stops an agent after 15 minutes without output or at a 90-minute cap. Finished agents ran at most 18.3 minutes and went at most 482 seconds without output. The in-runner team sweep no longer fails teammates that are still working.
- **A stopped agent keeps its partial result.** The runner died on SIGTERM without writing anything. It now writes its last output with the reason it stopped, and the parent is told that reason.
- **One report per agent, one per team.** The runner's exit, its SIGTERM handler, the reaper, a spawn failure and cancel could each settle the same agent and wake the parent. The row is now claimed atomically and only the claimant reports; a team's team-done is claimed the same way. A runner whose row was settled before it started does not start the model.
- **Cancel stops the CLI too.** `cancel_agent`, `cancel_team` and `edmund agents cancel` signalled the runner's pid only; they now stop its process group.
- **Completions that land together wake the parent once.** 85 of 234 completion wake-ups since May arrived within two minutes of another for the same chat, up to 19 in a row, each a full turn. A completion now waits 20 seconds for others (at most 90 seconds after the first) and they arrive as one event. Replayed over those 234: 49 fewer turns.
- **A sub-agent's background job runs inline.** Its wake-up went to an `agent:` session that does not exist (262 times, all skipped) and the agent polled `check_bg_job` instead. Every such job finished within 62 seconds.
- **A bad `agent_model` is named as such.** Ten agents failed at start on a model the CLI could not use, one of them the misspelled `claude-sonnet-5.5`. A malformed id is refused before anything spawns, and an unavailable one is reported as the configuration problem it is, not as a failed task.
