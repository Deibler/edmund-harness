---
"edmund-harness": minor
---

Recall searches inside the time a message names.

- When a message names a time ("back in June", "early August", "on 8/30", "three weeks ago", "last month"), per-turn recall also searches inside that window. The results show first, under "From <that time>", because the other blocks rank by meaning weighted toward recent and a newer match on the same subject buried the older one. The case that prompted it: "the clip of the meteor fireball from June".
- On 24 time-anchored questions from the operator's DM, the needed message reached the model 22 times, against 10 without. The 41-question replay set and the noise on subject-less messages are unchanged.
- Only marked months and dates count, so "you may" or "1/4 of the bake" do not. 5 of 1,315 of the operator's messages since June named a time, all genuinely.
- The cold-start log field is now `first_output`: the logger masked `first_token` as a secret.
