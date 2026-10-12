---
"edmund-harness": patch
---

Pin imcore-bridge 0.2.4, so a fresh install gets message edits that land on macOS 26. The daemon declares an edit's compatibility text as `NSAttributedString` and silently dropped edits that sent an `NSString`; the bridge now passes the class the daemon declares.
