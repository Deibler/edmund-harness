---
"edmund-harness": patch
---

A computer-use `wait` right after an action in a batch now ends once the screen has shown the action's effect and held still for 300 ms, instead of sleeping in full. The helper remembers the screen just before the input (the same apps a capture would show, below the menu bar, at half resolution) and compares frames exactly. A wait with no visible effect, one longer than 10 seconds, or one whose watch fails still sleeps the whole time. One 68-minute turn on 2026-09-23 spent 599 s in 560 waits, 532 of them a flat second. On the live screen, a change that appears at once returns in about 0.45 s, one that starts 800 ms late is not cut short, and a still or constantly animating screen waits the full time.
