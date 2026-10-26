---
"edmund-harness": patch
---

The memory governor now measures each process's physical footprint, the number Activity Monitor shows, instead of RSS. RSS leaves out compressed and swapped memory, so on 2026-10-25 the governor read 3 GB while the daemon held 10 GB and never stepped in. It also counts shared library pages, which made idle workers look several times bigger than they were. The dashboard's Daemon page shows the footprint too.
