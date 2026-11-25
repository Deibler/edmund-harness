---
"edmund-harness": patch
---

Keep a print's watches to that print, and stop a starting print from being ended by the last one's finish.

- Every start sets a state watch and an error watch for its print. Only progress and layer watches were retired when a print ended, so one more pair stayed active after each print and all of them fired for every later print. A watch tied to a print now speaks only for that print, its own end included, and a new print retires the watches bound to earlier ones. A watch set by hand with no print still covers every print.
- While a start is underway the printer can report the previous print's FINISH once more, and that report ended the new job before it had begun. A job can now end only after its start saw it begin, and a start clears any end recorded before it.
