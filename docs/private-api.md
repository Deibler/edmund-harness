# Private Apple frameworks

This project touches Messages in two ways. One is ordinary. The other is not,
and it is the reason the README asks you to read this page first.

## Reading: chat.db

`~/Library/Messages/chat.db` is the SQLite database Messages.app writes.
The daemon opens it read only, in WAL mode, on one shared connection. It
needs Full Disk Access and nothing else. Many tools read this file and Apple
changes its schema slowly. The one part that trips people up is that the text
of a message is often not in the `text` column but inside `attributedBody`, a
serialised typedstream; the decoder in `src/imessage/decode.ts` handles it,
and if you write your own you will find your outbound messages appear empty.

## Sending: the injected bridge

There is no public API for sending an iMessage from a script. AppleScript can
send a plain message to an existing chat and nothing more, and it breaks in
ways that report success. This project used to fall back to it and no longer
does.

Sending goes through [imcore-bridge](https://github.com/Deibler/imcore-bridge),
a dynamic library loaded into Messages.app with `DYLD_INSERT_LIBRARIES`. Inside
the process it calls IMCore, the private framework Messages itself uses, and
exposes a small set of operations over a Unix socket: send text and
attachments, react, edit, unsend, manage groups, read the chat registry. The
daemon supervises the injected process, probes it for liveness, and relaunches
Messages.app when it goes silent.

### What that requires

Messages.app is signed with library validation, so a foreign library will not
load into it while System Integrity Protection is on. Loading the bridge
requires:

1. SIP disabled from Recovery.
2. The boot argument `amfi_get_out_of_my_way=0x1`, also set from Recovery.
3. Xcode Command Line Tools to build the library for your machine.

The bridge repository has the exact commands. Both changes are system wide.
They weaken protections for every process on the Mac, not just Messages, and
they survive reboots until you reverse them. If you would not run other
software on this machine with SIP off, do not run this either. A dedicated Mac
mini with nothing else on it is the setup this was built on.

### What breaks

IMCore has no compatibility contract. Selectors change, behaviours change, and
none of it is documented. One example from this project's history: on macOS
26, the standard send method adjusts the chat's own recipient after the send,
and that made every second message go to the wrong thread. The fix was to
dispatch through a different registry method, found by diffing the system log
between a bridge send and a hand typed one. Expect the bridge to need work
after major OS updates, and expect the symptoms to be strange.

The harness is built to notice. After every send it checks `chat.db` for the
message and the chat it landed in, and the bridge refuses to send when the
chat it resolved is not the one addressed. Both guards exist because "sent"
was once a lie.

### What is deliberately not done

- The bridge never restarts `imagent`, the daemon that holds Apple's push
  registration. Bouncing it causes delayed receipts and dropped inbound for
  everyone on the account, and it never fixes anything the harness can fix.
- Diagnostics that enumerate every class in the Objective-C runtime are not
  used inside Messages.app; they trigger initialisers that crash the app in a
  loop.
- `killall Messages` by hand is discouraged because the supervisor relaunches
  it and hides what happened.

## Reversing it

Delete the bridge, quit Messages, re-enable SIP and clear the boot argument
from Recovery. Nothing else the harness does persists outside its own
directories.

## Affiliation

This project is not affiliated with, endorsed by, or supported by Apple.
iMessage, Messages and macOS are trademarks of Apple Inc. Using private
frameworks may violate the macOS software licence agreement; that is a
decision for the person running it.
