# Questions people ask

**Do I need an Anthropic or OpenAI API key?**
Not for the conversation. Turns run through the Claude Code or Codex CLI you
are logged into. Keys are needed only for optional paths: generation,
transcription, search, SMS.

**Can I run it on my own iMessage account?**
Yes, but every message you send from that Mac looks to the daemon like the
assistant speaking, and `[self].handles` has to list your addresses so it does
not answer you. Most people give it its own account.

**Does it work with SIP on?**
Reading does. Sending does not. The only send transport is a library injected
into Messages.app, which needs SIP off and an AMFI boot argument. There is no
AppleScript fallback any more because it failed while reporting success.

**Will it break when macOS updates?**
The reading side rarely. The sending side uses private frameworks with no
compatibility contract, and it has broken before. Expect to check the bridge
after major updates.

**Can it run on Linux or Windows, or on a server?**
No. It needs Messages.app and `chat.db` on a Mac that is signed in.

**Does it work with Codex instead of Claude Code?**
Yes. Set `[claude].model` to a `gpt-*` or `codex-*` name. You can switch back
and forth; the visible conversation stays continuous because the next turn
starts cold from persona, recall and history.

**Where is the memory and can I edit it?**
`persona/` as plain markdown. Edit any file; it applies on the next turn. See
[memory.md](memory.md).

**Does it remember things across different people's conversations?**
Not for contacts. Recall is scoped to the conversation, a person file is only
ever in that person's DMs, and the cross chat search scope only resolves for
the operator. The assistant does not answer one person with what another said
unless you, the operator, ask it to.

**Can I let the model run commands on my Mac?**
Yes, deliberately: set `[security].model_host_access = "full"`. The default
keeps the model to its own tools. Read [security.md](security.md) first; the
setting means the model can do anything your account can.

**How do I stop it messaging someone first?**
Proactive outreach is off by default. When on, each person can turn it off or
change its intensity from their portal, and the operator can with
`edmund sessions brownnose disable`.

**How do I let a stranger try it without giving them everything?**
Guest access with a campaign key. Guests get the persona and a reduced tool
set with no memory, history, scheduling or integrations. See the guest access
design record and `campaigns/example.md`.

**Why is there a kitchen integration?**
Because the author needed one. Several shipped skills and integrations are
specific to one house and one region. They are examples of the extension
model. Delete what you do not want; the build will not notice.

**Why is the config section called `[claude]` when it also configures Codex?**
History. Renaming it would break every existing config file for no functional
gain.

**How much does it cost to run?**
It depends on your subscription, your conversation sizes, and which optional
features you turn on. [costs.md](costs.md) explains the shape and gives a
query for your own numbers.

**Can several people share one assistant?**
Yes; that is the normal case. Each DM and each group is its own session with
its own memory and sandbox. There is no multi tenant mode in the sense of
several operators.

**Is my data sent anywhere?**
Conversation turns go to the model provider through the CLI. Optional tools go
to the providers you configure. Embeddings for recall run locally by default.
There is no telemetry. [security.md](security.md) has the table.

**The tests fail on a clean checkout. Is it broken?**
Some tests are known to flake under parallel load, and the list is in
`CLAUDE.md`. Compare the set of failures against that list, not the count. Run
`bun test tests/`, not bare `bun test`.

**Can I use it commercially or build a product on it?**
The licence is MIT. Whether injecting into Messages.app is acceptable for your
situation is a question for you and Apple's licence terms, not for this
project.
