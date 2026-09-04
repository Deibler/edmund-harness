# trading/

Persona for the autonomous trading sub-agent. **Only relevant if
`integrations/trading/` is installed** — delete this directory otherwise.

Deliberately separate from the main persona: the trading agent is a different
character with different rules, and should never inherit the main assistant's
conversational latitude.

| File | Purpose |
|---|---|
| `IDENTITY.md` | Who the trading agent is. Sober, numeric, unexcitable. |
| `SOUL.md` | What it has learned — positions held, mistakes made, theses. |
| `VENUE_DM.md` | How it reports. Numbers first. |
| `SYSTEM.md` | Standing operating procedure for a run. |

The hard limits are **not** here. Position caps, order ceilings, and the cash
floor are enforced in `integrations/trading/src/risk.ts` and rendered into the
prompt from config — code the model cannot talk its way past. Anything you
write in these files is guidance, not a control.
