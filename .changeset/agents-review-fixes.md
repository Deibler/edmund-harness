---
"edmund-harness": patch
---

Follow-ups to the sub-agent lifecycle change.

- **Dashboard cancel works again.** It still called a store method the lifecycle change removed, so cancelling from the dashboard returned an error and left a pending agent running. It now takes the same path as `cancel_agent`, and the overview counts stuck agents by the reaper's own limits.
- **A follow-on the daemon spawns gets the configured agent settings.** When the reaper settled a team's last member, the deep-research synthesizer it spawned ran on the default model, without plugins and under the wrong host-access policy, because the daemon's environment lacks the settings only MCP children get. The daemon now starts it from the same environment an MCP child of that conversation would have.
- **A stopped agent's result always says it was stopped.** When the CLI's exit reached the runner before its own SIGTERM, the result was written without the note, and the parent heard "stopped" while reading what looked like a complete result.
- **A team's synthesizer is always reported.** Two members settling at once could both see the team finished; one spawned the synthesizer while the other sent team-done before the synthesizer existed, and the synthesizer's result was then never reported. The follow-on and team-done decision is now taken under one lock.
- **Stopping kills the right process.** The reaper and cancel stopped the pid they had read before settling, which could be empty for an agent that had just started; they now stop the process the settle found, and the reaper's "never started" no longer lands on an agent that has started.
- **A long tool call does not look like a hang.** A sub-agent prints nothing while a tool runs, and its background tools now run inline (a video render polls for up to ten minutes), so the reaper could have stopped a healthy agent for silence. The agent's heartbeat is kept while its tool call runs.
