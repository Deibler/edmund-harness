#!/usr/bin/env python3
"""
This CLI is gone. The kitchen is MCP tools now.

Not a stub for its own sake. A long-lived chat session carries its context
forward for days, and that context includes the version of SKILL.md it read on
the day it started plus every `python3 pantry.py ...` it has run since. Deleting
the script out from under one of those sessions produces "No such file or
directory", which reads like a broken machine rather than a moved feature, and
the model's most likely next move is to work around it by hand — which is
exactly the failure this replaces.

That is not hypothetical. Jordan's session read the skill on 2026-08-15, when
this file WAS the system, and was still shelling out to it on 2026-08-16 after
the integration had landed, because nothing in its context had changed. It then
built two shopping lists by hand instead of calling `kitchen_shopping`, and the
groceries he actually bought never reached the ledger.

So this exits loudly with the mapping instead of vanishing.
"""

import sys

MOVED = {
    "list": "kitchen_status  (or kitchen_list for one location/category)",
    "have": "kitchen_status  — it reports what is stocked",
    "expiring": "kitchen_status  — expiring items come back in the same call",
    "add": "kitchen_record action:'add'",
    "use": "kitchen_record action:'use'",
    "cook": "kitchen_record action:'use', or kitchen_plan_resolve for a planned meal",
    "set": "kitchen_record action:'set'",
    "toss": "kitchen_record action:'toss'",
    "bulk": "kitchen_record  — it takes a list of items in one call",
    "shopping": "kitchen_shopping  — and it writes the shared Apple Note too",
    "plan": "kitchen_plan",
    "confirm": "kitchen_plan_resolve action:'done'",
    "cancel": "kitchen_plan_resolve action:'void'",
    "undo": "kitchen_undo",
    "tenant": "kitchen_accounts",
}

cmd = next((a for a in sys.argv[1:] if not a.startswith("-")), None)

print(
    "skills/kitchen/scripts/pantry.py was removed on 2026-08-17.\n"
    "The kitchen is an integration now: integrations/kitchen, exposed as MCP tools.\n",
    file=sys.stderr,
)
if cmd and cmd in MOVED:
    print(f"  `pantry.py {cmd}` is now:  {MOVED[cmd]}\n", file=sys.stderr)
else:
    print("  " + "\n  ".join(f"{k:<9} -> {v}" for k, v in MOVED.items()) + "\n", file=sys.stderr)
print(
    "Re-read the skill before continuing; the one in your context is out of date:\n"
    "  read_skill(\"kitchen\")\n"
    "Do NOT rebuild any of this by hand. If the kitchen_* tools are not in your\n"
    "tool list, find them with ToolSearch — they are deferred, not absent.",
    file=sys.stderr,
)
sys.exit(2)
