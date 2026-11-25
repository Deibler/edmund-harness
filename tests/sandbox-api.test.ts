/**
 * The modules and names that scripts outside this repository import.
 *
 * The assistant writes scripts in its sandboxes, and some of them import
 * harness source by absolute path: a scheduled job that asks the decision
 * model a question, a one-off that pushes a scene to the mirror, a helper
 * that sends through the bridge. Nothing in this repository can see those
 * imports. The compiler, the linter and knip all report such an export as
 * unused, and moving the file or dropping the `export` breaks the script
 * the next time it runs, silently, on someone else's schedule.
 *
 * It has happened: `integrations/kitchen/src/notesync.ts` was deleted while
 * sandbox scripts still imported `withNoteLock` from it.
 *
 * This list was measured on 2026-11-25 by searching every sandbox for an
 * import of a path under this checkout. Every entry below is imported by at
 * least one such script. The imports are static on purpose: a missing file
 * or a missing export fails this whole file at load, naming what is gone,
 * and knip counts each name as used.
 *
 * To move or rename something listed here, leave a re-export at the old
 * path, or find and update the scripts first. Add to the list when a new
 * script takes a new import; removing an entry needs the same search.
 */
import { expect, test } from "bun:test";
import { addToList, listPath, readList, removeFromList } from "../integrations/kitchen/src/list.ts";
import { restockPath, skip } from "../integrations/kitchen/src/restock.ts";
import { shopping, tripCount } from "../integrations/kitchen/src/shopping.ts";
import { fold, live } from "../integrations/kitchen/src/store.ts";
import { mirrorConfig } from "../integrations/mirror/config.ts";
import { publishMirrorAsset } from "../integrations/mirror/src/assets.ts";
import { summarizeContent } from "../integrations/mirror/src/protocol.ts";
import { MirrorStore } from "../integrations/mirror/src/store.ts";
import { toContentInput } from "../integrations/mirror/tools.ts";
import { FEATURES, parseGcode } from "../integrations/printer/src/gcode.ts";
import { render } from "../integrations/printer/src/preview.ts";
import { readSliced, zipEntry } from "../integrations/printer/src/threemf.ts";
import { loadConfig } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import { judgeSample, sampleTranscripts } from "../src/evals/judge.ts";
import { ADDRESS_QUESTIONS_VERSION, addressQuestions } from "../src/gating/address-check.ts";
import { ExchangeLog } from "../src/grok/exchanges.ts";
import { startGrokServer } from "../src/grok/server.ts";
import { checkEdmund, printerLineFrom } from "../src/grok/status.ts";
import { PageChecker } from "../src/ideation/page-check.ts";
import { ideationHeaders } from "../src/ideation/serve.ts";
import { CONTROL_SOCKET_ENV } from "../src/imessage/bridge/protocol.ts";
import { invoke } from "../src/imessage/bridge/route.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { decodeMessageText } from "../src/imessage/decode.ts";
import { confirmEdited, confirmUnsent, messageState } from "../src/imessage/edit-confirm.ts";
import { editMessage, sendMessage, unsendMessage } from "../src/imessage/send.ts";
import { askJev } from "../src/jev/client.ts";
import { loadToolContext } from "../src/mcp/context.ts";
import { assembleCoreTools } from "../src/mcp/server.ts";
import { transcribeMediaFile } from "../src/media/transcribe.ts";
import { embedQuery, makeProvider } from "../src/memory/embed-provider.ts";
import { RefreshScriptStore } from "../src/refresh/store.ts";
import { dmKeyFor } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";
import { resolveTwilioCreds } from "../src/sms/creds.ts";
import { createSmsSender } from "../src/sms/sender.ts";
import { smsChatGuidFor } from "../src/sms/session.ts";

const SANDBOX_API: Record<string, Record<string, unknown>> = {
  "integrations/kitchen/src/list.ts": { addToList, listPath, readList, removeFromList },
  "integrations/kitchen/src/restock.ts": { restockPath, skip },
  "integrations/kitchen/src/shopping.ts": { shopping, tripCount },
  "integrations/kitchen/src/store.ts": { fold, live },
  "integrations/mirror/config.ts": { mirrorConfig },
  "integrations/mirror/src/assets.ts": { publishMirrorAsset },
  "integrations/mirror/src/protocol.ts": { summarizeContent },
  "integrations/mirror/src/store.ts": { MirrorStore },
  "integrations/mirror/tools.ts": { toContentInput },
  "integrations/printer/src/gcode.ts": { FEATURES, parseGcode },
  "integrations/printer/src/preview.ts": { render },
  "integrations/printer/src/threemf.ts": { readSliced, zipEntry },
  "src/config/config.ts": { loadConfig },
  "src/cron/store.ts": { CronStore },
  "src/evals/judge.ts": { judgeSample, sampleTranscripts },
  "src/gating/address-check.ts": { ADDRESS_QUESTIONS_VERSION, addressQuestions },
  "src/grok/exchanges.ts": { ExchangeLog },
  "src/grok/server.ts": { startGrokServer },
  "src/grok/status.ts": { checkEdmund, printerLineFrom },
  "src/ideation/page-check.ts": { PageChecker },
  "src/ideation/serve.ts": { ideationHeaders },
  "src/imessage/bridge/protocol.ts": { CONTROL_SOCKET_ENV },
  "src/imessage/bridge/route.ts": { invoke },
  "src/imessage/db.ts": { ChatDb },
  "src/imessage/decode.ts": { decodeMessageText },
  "src/imessage/edit-confirm.ts": { confirmEdited, confirmUnsent, messageState },
  "src/imessage/send.ts": { editMessage, sendMessage, unsendMessage },
  "src/jev/client.ts": { askJev },
  "src/mcp/context.ts": { loadToolContext },
  "src/mcp/server.ts": { assembleCoreTools },
  "src/media/transcribe.ts": { transcribeMediaFile },
  "src/memory/embed-provider.ts": { embedQuery, makeProvider },
  "src/refresh/store.ts": { RefreshScriptStore },
  "src/sessions/key.ts": { dmKeyFor },
  "src/sessions/store.ts": { StateStore },
  "src/sms/creds.ts": { resolveTwilioCreds },
  "src/sms/sender.ts": { createSmsSender },
  "src/sms/session.ts": { smsChatGuidFor },
};

test("every name a sandbox script imports is still exported from the same path", () => {
  const gone: string[] = [];
  for (const [path, names] of Object.entries(SANDBOX_API)) {
    for (const [name, value] of Object.entries(names)) {
      if (value === undefined) gone.push(`${path}: ${name}`);
    }
  }
  expect(gone).toEqual([]);
});

test("the list is not empty by accident", () => {
  const count = Object.values(SANDBOX_API).reduce((n, names) => n + Object.keys(names).length, 0);
  expect(count).toBe(54);
});
