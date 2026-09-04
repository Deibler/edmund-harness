import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import {
  useCredits,
  useGrantCredit,
  useLiability,
  useRefreshCredits,
  useSetBillingMode,
  useSetWalletDisabled,
  useSyncWallet,
} from "@/features/credits/useCredits";
import { fmtTime, relativeTime } from "@/lib/time";
import type { CreditEventDto, WalletDto } from "@api/types";
import { useMemo, useState } from "react";

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
}

const REFUSAL_LABEL: Record<CreditEventDto["kind"], string> = {
  "refused-exhausted": "no credit left",
  "refused-short": "not enough for the clip",
  "refused-unavailable": "credits system unreachable",
  "refused-disabled": "paused by operator",
  "refused-account": "OpenRouter account out of funds",
  charged: "charged",
};

function PaysWith({ w }: { w: WalletDto }) {
  if (w.paysWith === "house-operator") return <Badge tone="neutral">global key · you</Badge>;
  if (w.paysWith === "house-group") return <Badge tone="neutral">global key · group</Badge>;
  if (w.paysWith === "house-override") return <Badge tone="neutral">global key · override</Badge>;
  const who = w.isOperator ? " · you, testing" : "";
  if (!w.hasKey) return <Badge tone="warn">own wallet · nothing paid yet{who}</Badge>;
  if ((w.remainingUsd ?? 0) <= 0.01) return <Badge tone="danger">own wallet · empty{who}</Badge>;
  return <Badge tone="ok">own wallet{who}</Badge>;
}

export function CreditsPage() {
  const { data, isLoading, isFetching } = useCredits();
  const refresh = useRefreshCredits();
  const setMode = useSetBillingMode();
  const grant = useGrantCredit();
  const sync = useSyncWallet();
  const setDisabled = useSetWalletDisabled();
  const liability = useLiability();
  const [newHandle, setNewHandle] = useState("");
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantUsd, setGrantUsd] = useState("5");
  const [showGroups, setShowGroups] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const say = (s: string) => {
    setMsg(s);
    setTimeout(() => setMsg(null), 4000);
  };
  const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e));

  const all = data?.wallets ?? [];
  const rows = useMemo(() => all.filter((w) => showGroups || w.kind === "dm"), [all, showGroups]);
  const groupCount = useMemo(() => all.filter((w) => w.kind === "group").length, [all]);
  const paywall = data?.paywall ?? [];
  const payments = useMemo(
    () =>
      all
        .flatMap((w) => w.payments.map((p) => ({ ...p, label: w.label, handle: w.handle })))
        .sort((a, b) => b.createdMs - a.createdMs)
        .slice(0, 50),
    [all],
  );
  const ready =
    data?.enabled && data.provisioningConfigured && data.stripeConfigured && data.webhookConfigured;
  const blocked = useMemo(
    () =>
      all.filter(
        (w) => w.paysWith === "wallet" && w.paywallHits > 0 && (w.remainingUsd ?? 0) <= 0.01,
      ),
    [all],
  );

  const toggleMode = (w: WalletDto) =>
    setMode.mutate(
      { sessionKey: w.sessionKey, mode: w.paysWith === "wallet" ? "house" : "wallet" },
      {
        onSuccess: () =>
          say(
            w.paysWith === "wallet"
              ? `${w.label} now generates on the global key`
              : `${w.label} now pays from their own wallet`,
          ),
        onError: fail,
      },
    );

  const submitGrant = () => {
    if (!grantFor) return;
    const n = Number(grantUsd);
    if (!(n > 0)) return say("Enter a positive amount");
    grant.mutate(
      { sessionKey: grantFor, usd: n },
      {
        onSuccess: (r) => {
          say(`Granted ${usd(n)}. Limit is now ${usd(r.limitUsd)} on OpenRouter.`);
          setGrantFor(null);
        },
        onError: fail,
      },
    );
  };

  const addPerson = (mode: "wallet" | "house") => {
    const h = newHandle.trim();
    if (!h) return say("Enter a phone or email");
    setMode.mutate(
      { handle: h, mode },
      {
        onSuccess: () => {
          setNewHandle("");
          say(`Added ${h} as ${mode === "house" ? "global key" : "own wallet"}`);
        },
        onError: fail,
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="Generation credits"
        description="Who pays for images, videos and audio. Every number here is read from OpenRouter and Stripe as the page loads; nothing is kept locally."
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => liability.mutate(undefined, { onError: fail })}
              disabled={liability.isPending}
            >
              {liability.isPending ? "Checking…" : "Check account cover"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => refresh.mutate(undefined, { onError: fail })}
              disabled={refresh.isPending || isFetching}
            >
              {refresh.isPending || isFetching ? "Reading…" : "Re-read now"}
            </Button>
          </div>
        }
      />

      {msg ? <p className="mb-3 text-sm text-fg">{msg}</p> : null}

      <Card className="mb-4">
        <CardHeader
          title="Status"
          subtitle={
            data
              ? data.enabled
                ? ready
                  ? `Enabled and fully configured. Live reads took ${(data.liveMs / 1000).toFixed(1)}s.`
                  : "Enabled, but a key is missing — see below."
                : "Disabled: everyone generates on the global key. Set [credits].enabled = true to start."
              : "…"
          }
        />
        <CardBody className="text-sm space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge tone={data?.enabled ? "ok" : "neutral"}>
              {data?.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge tone={data?.provisioningConfigured ? "ok" : "warn"}>
              management key {data?.provisioningConfigured ? "set" : "missing"}
            </Badge>
            <Badge tone={data?.stripeConfigured ? "ok" : "warn"}>
              stripe secret {data?.stripeConfigured ? "set" : "missing"}
            </Badge>
            <Badge tone={data?.webhookConfigured ? "ok" : "warn"}>
              webhook secret {data?.webhookConfigured ? "set" : "missing"}
            </Badge>
          </div>
          {data ? (
            <p className="text-muted">
              Starter {usd(data.settings.starterUsd)} · low-credit nudge under{" "}
              {usd(data.settings.lowWatermarkUsd)} · {Math.round(data.settings.creditRatio * 100)}¢
              of credit per $1 paid · top-ups {usd(data.settings.minTopupUsd)}–
              {usd(data.settings.maxTopupUsd)} · operator{" "}
              <code className="text-xs">{data.operatorHandle || "(unset)"}</code> and every group
              stay on the global key by default; flip your own row to "own wallet" to test the
              paywall and top-up as a user.
            </p>
          ) : null}
          {liability.data ? (
            <p className={liability.data.short ? "text-warn" : "text-muted"}>
              OpenRouter account has {usd(liability.data.accountRemainingUsd)} left; wallets hold{" "}
              {usd(liability.data.outstandingUsd)} ({liability.data.walletsRead}/
              {liability.data.wallets} read live)
              {liability.data.short
                ? " — the account cannot cover what people have paid for."
                : "."}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {blocked.length > 0 ? (
        <Card className="mb-4">
          <CardHeader
            title="Waiting at the paywall"
            subtitle="Asked for a generation, were refused for lack of credit, and still have none. Flip them to the global key or grant credit to unblock."
          />
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Person</Th>
                  <Th>Hits</Th>
                  <Th>Last hit</Th>
                  <Th>Actions</Th>
                </Tr>
              </Thead>
              <tbody>
                {blocked.map((w) => (
                  <Tr key={w.sessionKey}>
                    <Td>
                      <div className="text-sm">{w.label}</div>
                      <div className="text-xs text-muted">
                        <code>{w.handle}</code>
                      </div>
                    </Td>
                    <Td className="text-sm">{w.paywallHits}</Td>
                    <Td className="text-xs text-muted whitespace-nowrap">
                      {w.lastPaywallAtMs ? relativeTime(w.lastPaywallAtMs) : "—"}
                      {w.lastPaywallGeneration ? ` · ${w.lastPaywallGeneration}` : ""}
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          onClick={() => toggleMode(w)}
                          disabled={setMode.isPending}
                        >
                          Use global key
                        </Button>
                        <Button size="sm" onClick={() => setGrantFor(w.sessionKey)}>
                          Grant
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader
          title="Add a person"
          subtitle="Anyone who has texted Edmund is already listed below. Use this to set someone's treatment before they ever do."
        />
        <CardBody>
          <div className="flex gap-2 items-center max-w-xl">
            <Input
              placeholder="+17175551234 or name@example.com"
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
            />
            <Button size="sm" onClick={() => addPerson("wallet")}>
              Own wallet
            </Button>
            <Button size="sm" onClick={() => addPerson("house")}>
              Global key
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="Everyone"
          subtitle={`${rows.length} shown · ${groupCount} group${groupCount === 1 ? "" : "s"} ${showGroups ? "included" : "hidden"}`}
        />
        <CardBody className="p-0">
          <div className="px-4 py-2 border-b border-border">
            <label className="text-xs text-muted flex items-center gap-2">
              <input
                type="checkbox"
                checked={showGroups}
                onChange={(e) => setShowGroups(e.target.checked)}
              />
              show groups (always on the global key)
            </label>
          </div>
          {isLoading ? (
            <p className="p-4 text-sm text-muted">Reading OpenRouter and Stripe…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted">No conversations yet.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Person</Th>
                  <Th>Pays with</Th>
                  <Th>Remaining</Th>
                  <Th>Spent</Th>
                  <Th>Paid (Stripe)</Th>
                  <Th>Gift</Th>
                  <Th>Paywall</Th>
                  <Th>Last message</Th>
                  <Th>Actions</Th>
                </Tr>
              </Thead>
              <tbody>
                {rows.map((w) => (
                  <Tr key={w.sessionKey}>
                    <Td>
                      <div className="text-sm">{w.label}</div>
                      <div className="text-xs text-muted">
                        <code>{w.handle}</code>
                        {w.disabled ? (
                          <Badge tone="warn" className="ml-2">
                            paused
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      <PaysWith w={w} />
                    </Td>
                    <Td
                      className="text-sm"
                      title={
                        w.paysWith !== "wallet" || !w.hasKey
                          ? ""
                          : w.live
                            ? "read from OpenRouter just now"
                            : `live read failed; last seen ${w.lastSeenAtMs ? fmtTime(w.lastSeenAtMs) : "never"}`
                      }
                    >
                      {w.paysWith !== "wallet" ? "—" : w.hasKey ? usd(w.remainingUsd) : "$0.00"}
                      {w.paysWith === "wallet" && w.hasKey && !w.live ? (
                        <span className="ml-1 text-xs text-warn">stale</span>
                      ) : null}
                    </Td>
                    <Td className="text-sm">{w.hasKey ? usd(w.usageUsd) : "—"}</Td>
                    <Td
                      className="text-sm"
                      title={
                        w.creditedTotalUsd !== null ? `→ ${usd(w.creditedTotalUsd)} credit` : ""
                      }
                    >
                      {w.paidTotalUsd !== null && w.paidTotalUsd > 0 ? usd(w.paidTotalUsd) : "—"}
                    </Td>
                    <Td className="text-sm">
                      {w.operatorAdjustUsd !== null && w.operatorAdjustUsd > 0.001 ? (
                        usd(w.operatorAdjustUsd)
                      ) : w.operatorAdjustUsd !== null && w.operatorAdjustUsd < -0.001 ? (
                        <span className="text-warn">{usd(w.operatorAdjustUsd)}</span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="text-xs whitespace-nowrap">
                      {w.paywallHits > 0 ? (
                        <span className="text-warn">
                          {w.paywallHits}× ·{" "}
                          {w.lastPaywallAtMs ? relativeTime(w.lastPaywallAtMs) : ""}
                          {w.lastPaywallGeneration ? ` (${w.lastPaywallGeneration})` : ""}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td className="text-xs text-muted whitespace-nowrap">
                      {w.lastInboundMs ? relativeTime(w.lastInboundMs) : "never"}
                    </Td>
                    <Td>
                      {w.kind === "group" ? (
                        <span className="text-xs text-muted">always global key</span>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              onClick={() => toggleMode(w)}
                              disabled={setMode.isPending}
                            >
                              {w.paysWith === "wallet"
                                ? "Use global key"
                                : w.isOperator
                                  ? "Use own wallet (test as a user)"
                                  : "Use own wallet"}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() =>
                                setGrantFor(grantFor === w.sessionKey ? null : w.sessionKey)
                              }
                            >
                              Grant
                            </Button>
                            {w.hasKey ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={sync.isPending}
                                  onClick={() =>
                                    sync.mutate(w.sessionKey, {
                                      onSuccess: (r) =>
                                        say(
                                          r.raised
                                            ? `Raised ${w.label} by ${usd(r.raisedByUsd)} from Stripe`
                                            : `${w.label} already matches Stripe`,
                                        ),
                                      onError: fail,
                                    })
                                  }
                                >
                                  Sync
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() =>
                                    setDisabled.mutate(
                                      { sessionKey: w.sessionKey, disabled: !w.disabled },
                                      { onError: fail },
                                    )
                                  }
                                >
                                  {w.disabled ? "Resume" : "Pause"}
                                </Button>
                              </>
                            ) : null}
                          </div>
                          {grantFor === w.sessionKey ? (
                            <div className="mt-2 flex gap-1 items-center">
                              <Input
                                className="w-20"
                                type="number"
                                min={0.5}
                                step={0.5}
                                value={grantUsd}
                                onChange={(e) => setGrantUsd(e.target.value)}
                              />
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={submitGrant}
                                disabled={grant.isPending}
                              >
                                {grant.isPending ? "Raising…" : "Add credit"}
                              </Button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="Paywall hits"
          subtitle="Every refused generation, newest first. A row here means Edmund told someone their credit was out and sent their top-up link."
        />
        <CardBody className="p-0">
          {paywall.length === 0 ? (
            <p className="p-4 text-sm text-muted">Nobody has hit the paywall yet.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Person</Th>
                  <Th>Asked for</Th>
                  <Th>Why refused</Th>
                  <Th>Balance then</Th>
                  <Th>Detail</Th>
                </Tr>
              </Thead>
              <tbody>
                {paywall.map((e) => (
                  <Tr key={e.id}>
                    <Td className="text-xs text-muted whitespace-nowrap" title={fmtTime(e.atMs)}>
                      {relativeTime(e.atMs)}
                    </Td>
                    <Td>
                      <div className="text-sm">{e.label}</div>
                      <div className="text-xs text-muted">
                        <code>{e.handle}</code>
                      </div>
                    </Td>
                    <Td className="text-sm">{e.generation}</Td>
                    <Td>
                      <Badge tone={e.kind === "refused-exhausted" ? "warn" : "neutral"}>
                        {REFUSAL_LABEL[e.kind]}
                      </Badge>
                    </Td>
                    <Td className="text-sm">{usd(e.remainingUsd)}</Td>
                    <Td className="text-xs text-muted max-w-xs truncate" title={e.detail ?? ""}>
                      {e.detail ?? ""}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payments" subtitle="Read from Stripe as this page loaded." />
        <CardBody className="p-0">
          {payments.length === 0 ? (
            <p className="p-4 text-sm text-muted">No payments yet.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Person</Th>
                  <Th>Paid</Th>
                  <Th>Credited</Th>
                  <Th>Receipt</Th>
                </Tr>
              </Thead>
              <tbody>
                {payments.map((p) => (
                  <Tr key={p.paymentIntent}>
                    <Td
                      className="text-xs text-muted whitespace-nowrap"
                      title={fmtTime(p.createdMs)}
                    >
                      {relativeTime(p.createdMs)}
                    </Td>
                    <Td>
                      <div className="text-sm">{p.label}</div>
                      <div className="text-xs text-muted">
                        <code>{p.handle}</code>
                      </div>
                    </Td>
                    <Td className="text-sm">{usd(p.paidUsd)}</Td>
                    <Td className="text-sm">{usd(p.creditedUsd)}</Td>
                    <Td className="text-xs text-muted">
                      {p.receiptUrl ? (
                        <a
                          className="underline"
                          href={p.receiptUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          receipt
                        </a>
                      ) : null}
                      {p.invoicePdfUrl ? (
                        <>
                          {p.receiptUrl ? " · " : ""}
                          <a className="underline" href={p.invoicePdfUrl}>
                            invoice PDF
                          </a>
                        </>
                      ) : null}
                      {!p.receiptUrl && !p.invoicePdfUrl ? <code>{p.paymentIntent}</code> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
