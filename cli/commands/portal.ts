/**
 * `edmund portal link <handle>`   — print the person's current portal link.
 * `edmund portal revoke <handle>` — invalidate every link issued so far for
 *                                    that person; the next message carries
 *                                    the new one.
 *
 * A portal link is a bearer credential scoped to one conversation. Revoke
 * it when a phone is lost, a screenshot went somewhere it should not have,
 * or the person asks.
 */

import { loadConfig } from "../../src/config/config.ts";
import { loadPortalSecret, portalUrl, revokePortalLinks } from "../../src/portal/token.ts";
import { dmKeyFor } from "../../src/sessions/key.ts";
import type { Parsed } from "../args.ts";
import { fail, ok } from "../ui.ts";

export async function portalCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "help";
  const handle = p.positional[1];
  if (sub === "help" || !handle) {
    console.log("usage: edmund portal link <handle> | revoke <handle>");
    return;
  }
  const config = loadConfig();
  const sessionKey = handle.includes(":") ? handle : dmKeyFor(handle);
  const secret = loadPortalSecret(config.paths.data_dir);
  switch (sub) {
    case "link":
      console.log(portalUrl(config, secret, sessionKey));
      return;
    case "revoke": {
      const gen = revokePortalLinks(config.paths.data_dir, sessionKey);
      ok(`revoked every earlier portal link for ${sessionKey} (generation ${gen}).`);
      console.log(`new link: ${portalUrl(config, secret, sessionKey)}`);
      return;
    }
    default:
      fail(`unknown portal subcommand: ${sub}`);
  }
}
