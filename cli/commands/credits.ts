/**
 * `edmund credits list`                              every wallet, read live from OpenRouter + Stripe
 * `edmund credits show <handle>`                     one person: balance, payments, operator gifts
 * `edmund credits mode <handle> wallet|house`        per-person override
 * `edmund credits grant <handle> <usd>`              gift credit (raises the key's limit directly)
 * `edmund credits sync <handle>`                     make the limit catch up with Stripe now
 * `edmund credits pause <handle>` | `resume <handle>` disable/enable the key
 * `edmund credits liability`                         account credit vs Σ wallet balances
 *
 * Nothing here reads a local ledger: OpenRouter is asked what each key has,
 * Stripe is asked what each person paid.
 */

import { loadConfig } from "../../src/config/config.ts";
import { creditsLiability } from "../../src/credits/liability.ts";
import { updateKey } from "../../src/credits/openrouter-keys.ts";
import { walletSessionKeyFor } from "../../src/credits/resolve.ts";
import { CreditStore } from "../../src/credits/store.ts";
import { grantDirect, syncWallet } from "../../src/credits/sync.ts";
import type { Parsed } from "../args.ts";
import { color, fail, info, ok, print, section, table, warn } from "../ui.ts";

type Cfg = ReturnType<typeof loadConfig>;

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;

export async function creditsCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "list";
  const cfg = loadConfig();
  const store = new CreditStore(cfg.paths.data_dir);
  try {
    switch (sub) {
      case "list":
      case "ls":
        return await list(store, cfg);
      case "show":
        return await show(store, cfg, p.positional[1]);
      case "mode":
        return mode(store, p.positional[1], p.positional[2]);
      case "grant":
        return await grant(store, cfg, p.positional[1], p.positional[2]);
      case "sync":
        return await sync(store, cfg, p.positional[1]);
      case "pause":
        return await setDisabled(store, cfg, p.positional[1], true);
      case "resume":
        return await setDisabled(store, cfg, p.positional[1], false);
      case "liability":
        return await liability(store, cfg);
      default:
        fail(`unknown credits subcommand: ${sub}`);
        info(
          "usage: edmund credits [list|show <handle>|mode <handle> wallet|house|grant <handle> <usd>|sync <handle>|pause <handle>|resume <handle>|liability]",
        );
        process.exit(2);
    }
  } finally {
    store.close();
  }
}

function needHandle(handle: string | undefined): string {
  if (!handle) {
    fail("missing handle (phone or email)");
    process.exit(2);
  }
  return walletSessionKeyFor(handle);
}

async function list(store: CreditStore, cfg: Cfg): Promise<void> {
  const rows = store.list();
  section("generation credit wallets (live)");
  if (rows.length === 0) {
    info("none — rows appear on first charged generation or `edmund credits mode <handle> …`");
    return;
  }
  const out: string[][] = [];
  for (const w of rows) {
    const handle = w.sessionKey.replace(/^imessage:dm:/, "");
    if (w.billingMode === "house" || !w.apiKey) {
      out.push([
        handle,
        w.billingMode === "house" ? color.dim("global key") : "wallet (no key yet)",
        "—",
        "—",
        "—",
        "—",
        w.disabled ? "yes" : "",
      ]);
      continue;
    }
    try {
      const v = await syncWallet({ config: cfg, store, sessionKey: w.sessionKey });
      out.push([
        handle,
        "own wallet",
        usd(v.status.remainingUsd),
        usd(v.status.usageUsd),
        v.stripe ? usd(v.stripe.totalPaidCents / 100) : color.dim("stripe?"),
        v.operatorAdjustUsd !== null && v.operatorAdjustUsd > 0 ? usd(v.operatorAdjustUsd) : "",
        w.disabled || v.status.disabled ? "yes" : "",
      ]);
    } catch (err) {
      out.push([
        handle,
        "own wallet",
        color.dim(`unreadable: ${String(err).slice(0, 40)}`),
        "",
        "",
        "",
        "",
      ]);
    }
  }
  table(["handle", "pays with", "remaining", "spent", "paid (stripe)", "gift", "paused"], out);
}

async function show(store: CreditStore, cfg: Cfg, handle: string | undefined): Promise<void> {
  const key = needHandle(handle);
  const w = store.get(key);
  if (!w) {
    fail(`no wallet row for ${key}`);
    return;
  }
  section(key);
  print(`  pays with:  ${w.billingMode === "house" ? "global key" : "own wallet"}`);
  print(`  key:        ${w.keyHash ? `${w.keyHash.slice(0, 12)}…` : "(none minted yet)"}`);
  if (w.billingMode === "house" || !w.apiKey) return;
  const v = await syncWallet({ config: cfg, store, sessionKey: key });
  if (v.raised) ok(`limit raised by ${usd(v.raisedByUsd)} to match Stripe`);
  print(`  remaining:  ${usd(v.status.remainingUsd)}   (OpenRouter, live)`);
  print(`  limit:      ${usd(v.status.limitUsd)}`);
  print(`  spent:      ${usd(v.status.usageUsd)}`);
  if (v.stripe) {
    print(
      `  paid:       ${usd(v.stripe.totalPaidCents / 100)} → ${usd(v.stripe.totalCreditedUsd)} credit   (Stripe, live)`,
    );
    if (v.operatorAdjustUsd !== null && v.operatorAdjustUsd > 0.001)
      print(`  gift:       ${usd(v.operatorAdjustUsd)} above what payments account for`);
    if (v.operatorAdjustUsd !== null && v.operatorAdjustUsd < -0.001)
      warn(
        `  limit is ${usd(-v.operatorAdjustUsd)} BELOW starter + payments (refund? lowered by hand?)`,
      );
    if (v.stripe.payments.length) {
      print("");
      table(
        ["when", "payment", "paid", "credited"],
        v.stripe.payments.map((x) => [
          new Date(x.createdMs).toLocaleString(),
          x.paymentIntent.slice(0, 22),
          usd(x.paidCents / 100),
          usd(x.creditedUsd),
        ]),
      );
    }
  } else {
    warn("  Stripe could not be read just now");
  }
  print(`  paused:     ${w.disabled || v.status.disabled ? "yes" : "no"}`);
}

function mode(store: CreditStore, handle: string | undefined, m: string | undefined): void {
  const key = needHandle(handle);
  if (m !== "wallet" && m !== "house") {
    fail("mode must be `wallet` or `house`");
    process.exit(2);
  }
  store.setMode(key, m);
  ok(`${key} → ${m === "house" ? "global key" : "own wallet"}`);
}

async function grant(
  store: CreditStore,
  cfg: Cfg,
  handle: string | undefined,
  amount: string | undefined,
): Promise<void> {
  const key = needHandle(handle);
  const n = Number(amount);
  if (!(n > 0)) {
    fail("amount must be a positive number of dollars");
    process.exit(2);
  }
  const status = await grantDirect({ config: cfg, store, sessionKey: key, usd: n });
  ok(`granted ${usd(n)} to ${key} — limit now ${usd(status.limitUsd)} (OpenRouter)`);
}

async function sync(store: CreditStore, cfg: Cfg, handle: string | undefined): Promise<void> {
  const key = needHandle(handle);
  const v = await syncWallet({ config: cfg, store, sessionKey: key });
  if (v.raised) ok(`raised ${key} by ${usd(v.raisedByUsd)} → limit ${usd(v.status.limitUsd)}`);
  else
    info(
      `${key} already up to date — limit ${usd(v.status.limitUsd)}, remaining ${usd(v.status.remainingUsd)}`,
    );
}

async function setDisabled(
  store: CreditStore,
  cfg: Cfg,
  handle: string | undefined,
  disabled: boolean,
): Promise<void> {
  const key = needHandle(handle);
  const w = store.get(key);
  if (!w) {
    fail(`no wallet row for ${key}`);
    return;
  }
  if (w.keyHash) {
    if (!cfg.keys.openrouter_provisioning) {
      fail("keys.openrouter_provisioning is not set");
      process.exit(1);
    }
    await updateKey({
      provisioningKey: cfg.keys.openrouter_provisioning,
      hash: w.keyHash,
      patch: { disabled },
    });
  }
  store.setDisabled(key, disabled);
  ok(`${key} ${disabled ? "paused" : "resumed"}`);
}

async function liability(store: CreditStore, cfg: Cfg): Promise<void> {
  const l = await creditsLiability({ store, houseKey: cfg.keys.openrouter });
  section("credits liability");
  print(`  OpenRouter account remaining:  ${usd(l.accountRemainingUsd)}`);
  print(
    `  Σ wallet balances outstanding: ${usd(l.outstandingUsd)} (${l.walletsRead}/${l.wallets} read live)`,
  );
  if (l.short) warn("the account cannot cover what people have paid for — add OpenRouter credit");
  else ok("covered");
}
