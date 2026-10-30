---
"edmund-harness": patch
---

On a FaceTime call, a background agent's result reaches Edmund as soon as the agent finishes, with the result already in hand.

- Agent completions are debounced 20 s so a burst becomes one reply. That suits texting, but on the first live call it, plus the turn in flight, kept the caller waiting 27 s. While a call is live, the call manager's 300 ms poll now brings that conversation's pending completion wake-ups forward to now (`CronStore.expedite`) and pokes the scheduler. Texting keeps the debounce.
- Those wake-ups carry each finished agent's result inline (capped at 4,000 characters). Calling `read_agent_result` was one more model round trip, 7-10 s on that call, before Edmund could say anything. Team completions still use `read_team_results`.
