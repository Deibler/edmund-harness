---
"edmund-harness": patch
---

A guest campaign can run with the allowlisted loadout, and `create_chat` always sends the first message.

- **Campaign loadout.** A `[[guest_campaigns]]` entry takes `loadout = "allowlisted"` to give its keyed guests the tools an allowlisted DM gets under `[security]`, browser included, instead of the reduced guest surface. The key's expiry, its caps and its campaign context still apply, and the guest section of the prompt stops describing a reduced tool surface those guests do not have. The default, `"guest"`, is unchanged.
- **`create_chat` sends its first message.** IMCore mints a new chat on this Mac only, and nobody else sees it until a message goes out, so a create with no message reported success for a group that existed on no one's phone. `text` is now required, the result names the chat it went to, and the description says the person asking is not added unless their handle is included.
