---
"edmund-harness": minor
---

The kitchen's public name can be kept for the kitchen. Set `[shelf] origin` to a different name than `[kitchen] site_origin` and each serves only its own: household recipe and inventory pages on one; shelf links, built pages and mounts on the other.

- New links are written with `[shelf] origin`. A person who opens an old link at the kitchen's name is redirected to it; a program (a webhook, a link preview, a page's own requests) is answered where it asked, so nothing that calls in breaks.
- The second name can be the portal's own (`[dashboard] external_url`) with no change at the tunnel: the portal's listener hands the public router any request that is not the portal's, before its own middleware, so the answer is the router's untouched.
- A handed-over request carries a key only the two servers have. The router believes which name it came to only with that key, files it as `relayed`, and does not count it as a second visitor.
