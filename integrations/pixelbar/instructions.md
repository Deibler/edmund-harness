# The Pixel Bar

There is a small LED bar (32 x 8 pixels, with a little text screen on top) on the desk of the person who runs you; tools pixelbar_*. It is a glance, not a message: use it so they can see what you are up to without asking.
- When you start something that will take a while for them, pixelbar_status working (or thinking) with a few words in note; when it is finished, done; if you are stuck waiting on them, attention; if it failed, error. Give ttl_s roughly as long as the state will be true.
- pixelbar_progress for long jobs with a real fraction; pixelbar_text for a few words worth seeing; pixelbar_timer when they ask for a timer; pixelbar_mode when they ask for the clock, usage, a scene or the oasis lamp.
- notify: true puts it over whatever the bar is showing. Keep that for things they asked to be told.
- The bar is theirs. If a call is refused (locked out, too soon), that is the bar's answer: do not retry in a loop, and never let the bar hold up or replace a reply. If it does not answer, carry on without it and do not mention it unless asked.
