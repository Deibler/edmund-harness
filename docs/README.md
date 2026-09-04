# Documentation

Start with the [root README](../README.md). This directory holds everything
longer than a README paragraph.

| Goal | Start here |
|---|---|
| Install and send the first message | [getting-started.md](getting-started.md) |
| Understand what the private API surface costs you | [private-api.md](private-api.md) |
| Understand what runs and how a message becomes a reply | [architecture.md](architecture.md) |
| Every config key and its default | [configuration.md](configuration.md) |
| Every `edmund` command | [cli.md](cli.md) |
| How memory works and how to edit it | [memory.md](memory.md) |
| What the model can call | [tools.md](tools.md) |
| Reminders, triggers, missions, proactive outreach | [proactive.md](proactive.md) |
| What happens when something fails | [recovery.md](recovery.md) |
| Symptoms and what they have meant before | [troubleshooting.md](troubleshooting.md) |
| Services, logs, spend, backup, upgrade | [operations.md](operations.md) |
| Threat model and what leaves the machine | [security.md](security.md) |
| What costs money and which levers move it | [costs.md](costs.md) |
| Write a skill | [skills.md](skills.md) |
| Write an integration | [integrations.md](integrations.md), [integrations/README.md](../integrations/README.md) |
| The operator dashboard | [dashboard.md](dashboard.md) |
| The per person portal | [user-portal.md](user-portal.md) |
| Per person generation credits | [generation-credits.md](generation-credits.md) |
| The SMS channel | [sms-channel.md](sms-channel.md) |
| Contribute a change | [development.md](development.md), [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Questions people ask | [faq.md](faq.md) |
| Words this project uses | [glossary.md](glossary.md) |

## Design records

`design/` holds the plan written before or during each subsystem. They are
kept because they explain why the shipped design looks the way it does. Each
one carries a banner saying so; where a record and the code disagree, the code
is right.

| Record | Subsystem |
|---|---|
| [brownnose-plan.md](design/brownnose-plan.md) | Proactive outreach: intensity, pacing, decay |
| [recovery-plan.md](design/recovery-plan.md) | Failure classes, healers, recovery turns |
| [relay-plan.md](design/relay-plan.md) | Messaging another person from a conversation |
| [resident-agent-plan.md](design/resident-agent-plan.md) | The warm worker pool |
| [imcore-notify-plan.md](design/imcore-notify-plan.md) | Push based inbound versus polling |
| [capabilities-plan.md](design/capabilities-plan.md) | The order capabilities were added in |
| [missions-plan.md](design/missions-plan.md) | Long running goals; what shipped differs |
| [perf-plan.md](design/perf-plan.md) | A performance and reliability sweep |
| [guest-access-plan.md](design/guest-access-plan.md) | Campaign keys and vouched guests |
| [generation-credits-plan.md](design/generation-credits-plan.md) | Per person wallets, and the decisions behind them |

## Research

[research/memory-architecture-2026-07-28.md](research/memory-architecture-2026-07-28.md)
is the literature review behind the memory layers: what LongMemEval and the
consolidation papers say, and how that became person files, principles and
archives.

## Integration documentation lives with the package

- [integrations/README.md](../integrations/README.md) explains the plugin
  model and the manifest.
- Each integration has its own README where it needs one.

## Private

`docs/private/` is gitignored. It holds documents that belong to one
deployment rather than to the project: carrier filings, roadmaps with real
usage numbers, product planning drafts.
