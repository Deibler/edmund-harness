---
"edmund-harness": minor
---

Inbound traffic is told apart: visitors, crawlers, and the programs that probe every address.

- Every request a harness server answers is recorded with the public name it was sent to, the address and country it came from, what kind of client sent it (browser, link preview, crawler, tool, scanner), and which known probes it matches: a secrets file, the admin page of software that is not installed, a router's setup form, a traversal, an injection. The query is read to decide and never stored.
- Each client is watched over ten minutes. One that matches probe after probe or asks for many addresses that are not there is a `scan`; one refused again and again is a `brute-force`; hundreds of requests a minute is a `flood`. Each is one line in the `security` channel, and a flood or a brute force alerts the operator.
- The site server that serves a shared artifact through a tunnel of its own now records its requests too; they never passed the public router.
- Every five minutes the daemon records what is reachable from outside the machine: each tunnel and what it publishes, and each network listener. One that opens is a warning.
- `edmund logs traffic` sums a period: by server, public name, client kind and country, the clients that probed most, what was flagged, the hours that stand out, and what is exposed.
- A request for something that is not there is no longer filed as a warning: a 404 is the asker's mistake, and only a server fault is copied to `error`.
