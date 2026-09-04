---
name: iterative-image-editing
description: Handle multi-turn image generate/edit requests where the user gives one small correction at a time (remove X, swap Y for Z, make it more cartoonish); chain from the latest version and touch only what was named.
---

Trigger: a user asks for an image (new render, edited photo, or cartoon) and then follows up in later messages with short, targeted corrections rather than a fresh description — e.g. "remove the halo and the pony top," "instead of a cat can you put a shih tzu," "make it more cartoonish," "make her prettier," "redo the picture to make them all look a little drunk," "make it look like a dinosaur with a mullet." This is a distinct task shape from a one-shot image request: the thread is really editing a single persistent image across several rounds.

1. Treat the most recently produced image as the live working image for the rest of that thread, not the original prompt or the original uploaded photo. Every correction applies to that latest version, not to what came before it.
2. Change only what the correction names. Do not regenerate the whole scene — preserve pose, background, other subjects, colors, and composition unless the user's wording clearly covers them too. These are targeted small edits, not requests for a fresh take.
3. Recognize the common correction shapes as "edit this," not "start over": remove/add one element, swap one subject or object for another, shift art style (cartoonish, photoreal, a named exaggerated style), adjust one attribute (age, expression, color, prettiness), change composition (both subjects in frame, a pose/interaction), or restyle using a newly supplied reference photo for likeness while keeping prior style choices.
4. Only ask a clarifying question when the correction is genuinely ambiguous about which subject or element it targets. Most of these messages are terse but unambiguous given the current image — don't slow the exchange down with unnecessary questions, since these threads are usually casual and move fast (family/friend chats, several rounds in a few minutes).
5. After each edit, name briefly what changed so the user can confirm or issue the next correction, since these threads commonly run three to six rounds before landing.
6. If a new reference photo is dropped mid-thread ("use this picture of the dog"), swap in that subject's likeness but keep other established style decisions from the thread unless told otherwise.
