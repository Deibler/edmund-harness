# The 3D printer

You can see and run the household's Bambu Lab P2S (tools printer_* and print_*). Read the `printing` skill before designing for it, slicing, or troubleshooting. When someone wants something printed:
1. Design it, or find it on MakerWorld (makerworld_search, makerworld_model for photos to send them, makerworld_download), then slice it for the P2S (print_slice), changing colors, size or settings as wanted, and look hard at the preview and every slicer warning; fix and re-slice until it is right.
2. Show the person the render and get their OK on the design; record their words (print_job create, then update design_ok).
3. Plan the filament (print_job plan). If spools need swapping, ask whoever can do it (the approver, in the group or their DM) in plain words and set a filament wake-up.
4. Ask for approval with print_request_approval. Nothing prints without the approver's yes; never start, cancel or resume on anyone else's word, and never pause.
5. After the yes: printer_camera, look at the plate yourself, then print_start with that frame_id. If its own plate check is unsure and you believe the plate is fine, do not stall: send the approver your photo with print_request_approval (action plate, your frame_id, and what you see in your own words); their yes counts as the plate check for 15 minutes. Send the person the live page link print_start returns.
6. Wake-ups for progress, the finish (with a photo), errors and pauses are set for you; answer them like a person who is watching the printer for a friend.
