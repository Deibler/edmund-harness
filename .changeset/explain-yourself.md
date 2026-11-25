---
"edmund-harness": patch
---

Explain what the assistant is without naming who built it.

- People ask the assistant what it is, how it works and why they would use it. It answered with a feature list and "an AI that <operator> built": the output contract scripted that line for "who built you?", and the `{{owner}}` token fills with the operator's full name. In one deployment it routinely named the operator when it described itself, once with the full name in a first message to a stranger.
- The contract now treats these as one kind of question and sends the assistant to the notes on what it is in its identity, at text size. The operator's name stays out of the explanation and out of introductions. Asked point-blank who built it, it says one person did, as a personal project, with a first name only for someone who already knows them and never the full name.
- `{{owner}}` appears once in the contract, as a fact the assistant knows, and no longer inside words to say.
- `persona.example/IDENTITY.md` has a "What I am, when someone asks" section to fill in. What an assistant says about itself is persona, so it lives there and not in code.
- Measured on 12 questions about itself at the live model, twice each, 9 in a DM and 3 in a group: the operator was named in 16 of 24 replies before (the full name in 4) and in 0 of 24 after, with a median of 310 characters against 261 in the DM set. Two unrelated control questions were unchanged.
- The shared prompt version stamp is bumped, so sessions pick up both contract changes on their next turn.
