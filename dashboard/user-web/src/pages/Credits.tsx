import { PageTitle } from "@/components/PageTitle";
import { Paper, Tag } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { basePath, post } from "@/lib/api";
import { fmtDateShort, fmtDay, fmtHour, fmtTime, money, moneyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PortalActivity, PortalActivityRow, PortalCredits, PortalPageData } from "@/types";
import { DownloadIcon, ReceiptIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const MEDIA_LABEL: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  other: "Model call",
};

const REFUSAL: Record<string, string> = {
  "refused-exhausted": "no credit left",
  "refused-short": "not enough for the clip",
  "refused-unavailable": "credits unavailable",
  "refused-disabled": "paused",
  "refused-account": "service out of funds",
};

type Filter = "all" | "image" | "video" | "audio" | "credit" | "refused";
const FILTERS: Array<{ id: Filter; name: string }> = [
  { id: "all", name: "All" },
  { id: "image", name: "Images" },
  { id: "video", name: "Video" },
  { id: "audio", name: "Audio" },
  { id: "credit", name: "Credit added" },
  { id: "refused", name: "Refused" },
];

const isCredit = (r: PortalActivityRow) =>
  r.kind === "payment" || r.kind === "starter" || r.kind === "operator-credit";
const isRefusal = (r: PortalActivityRow) => r.kind.startsWith("refused-");

function matches(r: PortalActivityRow, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "credit") return isCredit(r);
  if (f === "refused") return isRefusal(r);
  return r.kind === "generation" && r.media === f;
}

function whatLabel(r: PortalActivityRow): string {
  if (r.kind === "generation") return MEDIA_LABEL[r.media ?? "other"] ?? "Model call";
  if (r.kind === "payment") return "Credit added";
  if (r.kind === "starter") return "Starter credit";
  if (r.kind === "operator-credit") return "Credit from the operator";
  return MEDIA_LABEL[r.media ?? "other"] ?? "Request";
}

/** Rows keyed without leaning on their index. */
function keyed(rows: PortalActivityRow[]): Array<{ key: string; r: PortalActivityRow }> {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.kind}:${r.generationId ?? r.reference ?? r.atMs}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: n === 1 ? base : `${base}#${n}`, r };
  });
}

function csvFor(rows: PortalActivityRow[], tz: string): string {
  const q = (s: string | number | null) => {
    if (s === null || s === undefined) return "";
    const t = String(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = [
    "Date",
    "Time",
    "Activity",
    "Model",
    "Cost (USD)",
    "Credit (USD)",
    "Balance after (USD)",
    "Note",
    "Generation id",
    "Reference",
  ];
  const lines = rows.map((r) =>
    [
      fmtDateShort(r.atMs, tz),
      r.atExact ? fmtTime(r.atMs, tz) : `about ${fmtHour(r.atMs, tz)}`,
      whatLabel(r),
      r.model,
      r.costUsd === null ? null : r.costUsd.toFixed(6),
      r.creditUsd === null ? null : r.creditUsd.toFixed(2),
      r.balanceAfterUsd === null ? null : r.balanceAfterUsd.toFixed(4),
      isRefusal(r) ? `Refused: ${REFUSAL[r.kind] ?? "refused"}` : r.detail,
      r.generationId,
      r.reference,
    ]
      .map(q)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

async function loadActivity(): Promise<PortalActivity> {
  const res = await fetch(`${basePath()}/credits/activity`, {
    headers: { Accept: "application/json" },
  });
  const json = (await res.json().catch(() => ({}))) as {
    activity?: PortalActivity;
    error?: string;
  };
  if (!res.ok || !json.activity) throw new Error(json.error ?? `Could not load (${res.status})`);
  return json.activity;
}

type ActivityState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; activity: PortalActivity; atMs: number };

const PAGE = 25;

export function Credits({ data, credits: c }: { data: PortalPageData; credits: PortalCredits }) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<number | "custom" | null>(null);
  const ready = c.checkoutReady && !c.disabled;
  const pct = Math.round(c.ratio * 100);

  const topUp = async (amountUsd: number, key: number | "custom") => {
    if (!(amountUsd > 0)) {
      toast.error("Enter an amount");
      return;
    }
    setBusy(key);
    const r = await post<{ url: string }>("/credits/checkout", { amountUsd });
    if (!r.ok) {
      setBusy(null);
      toast.error(r.error);
      return;
    }
    location.href = r.url;
  };

  const added = (c.creditedTotalUsd ?? 0) + (c.operatorCreditUsd ?? 0);

  return (
    <div>
      <PageTitle
        title="Credits"
        lede="Images, video and audio Edmund makes for you run on prepaid credit that is yours alone. Everything else he does is unaffected."
      />

      <Paper>
        <div className="grid gap-5 sm:grid-cols-[1.5fr_1fr_1fr] sm:gap-6">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Available now
            </div>
            <div className="font-heading tnum mt-1.5 text-[3rem] leading-none">
              {money(c.remainingUsd)}
            </div>
          </div>
          <div className="border-border/70 sm:border-l sm:pl-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Spent
            </div>
            <div className="font-heading tnum mt-1.5 text-[1.75rem] leading-none">
              {money(c.usageUsd)}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">on generations</div>
          </div>
          <div className="border-border/70 sm:border-l sm:pl-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Added
            </div>
            <div className="font-heading tnum mt-1.5 text-[1.75rem] leading-none">
              {c.creditedTotalUsd === null ? "—" : money(added)}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">
              {c.payments.length === 0
                ? "no payments yet"
                : `${c.payments.length} payment${c.payments.length === 1 ? "" : "s"}${
                    c.operatorCreditUsd
                      ? ` + ${money(c.operatorCreditUsd)} from ${data.ownerName}`
                      : ""
                  }`}
            </div>
          </div>
        </div>
        {c.disabled ? (
          <p className="mt-5 text-[14px] text-muted-foreground">
            Generation is paused for you right now. {data.ownerName} can turn it back on.
          </p>
        ) : c.unavailable ? (
          <p className="mt-5 text-[14px] text-muted-foreground">
            {c.unavailable}. Your balance above is what OpenRouter reports.
          </p>
        ) : null}
        <p className="mt-5 text-[13.5px] leading-relaxed text-muted-foreground">
          A typical image costs a few cents; a short video can run a few dollars. These figures are
          read from OpenRouter and Stripe each time you open this page. Nothing is kept in between.
        </p>
      </Paper>

      <Paper
        title="Add credit"
        description={`Card payment through Stripe. Each $1 becomes $${c.ratio.toFixed(2)} of credit; the difference is the card and provider fees, passed through at cost. Sales tax, where it applies, is added at checkout. Minimum $${c.minTopup.toFixed(0)}.`}
      >
        <div className="grid grid-cols-3 gap-2">
          {c.presets.map((p) => (
            <Button
              key={p}
              disabled={!ready || busy !== null}
              onClick={() => topUp(p, p)}
              className="h-12 text-[16px] font-semibold"
            >
              {busy === p ? "Opening…" : `$${p}`}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
              $
            </span>
            <Input
              type="number"
              inputMode="decimal"
              min={c.minTopup}
              max={c.maxTopup}
              step={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={`${c.minTopup} to ${c.maxTopup}`}
              className="tnum h-12 bg-card pl-7 text-[16px]"
            />
          </div>
          <Button
            variant="outline"
            disabled={!ready || busy !== null}
            onClick={() => topUp(Number(custom), "custom")}
            className="h-12 px-5 text-[15px]"
          >
            {busy === "custom" ? "Opening…" : "Add"}
          </Button>
        </div>
        {!c.checkoutReady ? (
          <p className="mt-3 text-[13.5px] text-muted-foreground">
            Card payments are not switched on yet. Ask {data.ownerName}.
          </p>
        ) : null}
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
          Another amount becomes {pct}% credit the same way. Your credit is there the moment Stripe
          confirms the payment; come back to this page or just ask Edmund for the image.
        </p>
      </Paper>

      <ActivityTable tz={data.tz} />

      <Paper
        title="Transactions"
        description="Every payment you have made, from Stripe. Receipts open in a new tab; the invoice is a PDF."
        padded={false}
      >
        {c.payments.length === 0 ? (
          <p className="px-4 pb-5 pt-1 text-[14px] text-muted-foreground sm:px-5">
            {c.paidTotalUsd === null ? "Could not be read from Stripe just now." : "Nothing yet."}
          </p>
        ) : (
          <div className="pt-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.payments.map((p) => (
                  <TableRow key={p.paymentIntent}>
                    <TableCell>
                      <div className="whitespace-nowrap">{fmtDateShort(p.atMs, data.tz)}</div>
                      <div className="text-[12.5px] text-muted-foreground">
                        {fmtTime(p.atMs, data.tz)}
                      </div>
                      <div
                        className="mt-0.5 hidden max-w-[14rem] truncate font-mono text-[11.5px] text-muted-foreground/80 md:block"
                        title={p.paymentIntent}
                      >
                        {p.paymentIntent}
                      </div>
                    </TableCell>
                    <TableCell className="tnum whitespace-nowrap text-right">
                      {money(p.paidUsd)}
                    </TableCell>
                    <TableCell className="tnum whitespace-nowrap text-right text-emerald">
                      +{money(p.creditedUsd)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:justify-end">
                        {p.receiptUrl ? (
                          <a
                            href={p.receiptUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground hover:bg-secondary"
                          >
                            <ReceiptIcon className="size-3.5" /> Receipt
                          </a>
                        ) : null}
                        {p.invoicePdfUrl ? (
                          <a
                            href={p.invoicePdfUrl}
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground hover:bg-secondary"
                            aria-label="Download invoice PDF"
                          >
                            <DownloadIcon className="size-3.5" /> PDF
                          </a>
                        ) : null}
                        {!p.receiptUrl && !p.invoicePdfUrl ? (
                          <span className="text-[12.5px] text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Paper>
    </div>
  );
}

function ActivityTable({ tz }: { tz: string }) {
  const [state, setState] = useState<ActivityState>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    setState((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    try {
      const activity = await loadActivity();
      setState({ kind: "ready", activity, atMs: Date.now() });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state.kind === "ready" ? state.activity.rows : [];
  const available = useMemo(
    () => FILTERS.filter((f) => f.id === "all" || rows.some((r) => matches(r, f.id))),
    [rows],
  );
  const filtered = useMemo(() => keyed(rows.filter((r) => matches(r, filter))), [rows, filter]);
  const visible = filtered.slice(0, shown);

  const summary =
    state.kind === "ready"
      ? `${state.activity.generations} generation${state.activity.generations === 1 ? "" : "s"} since ${fmtDay(state.activity.sinceMs, tz)} · ${moneyExact(state.activity.spentUsd)} spent`
      : null;

  return (
    <Paper
      title={
        <span className="flex items-center justify-between gap-3">
          <span>Activity</span>
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[12.5px] text-muted-foreground"
              onClick={() => void load()}
              aria-label="Read again"
              disabled={state.kind === "loading"}
            >
              <RefreshCwIcon
                className={cn("size-3.5", state.kind === "loading" && "animate-spin")}
              />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[12.5px] text-muted-foreground"
              disabled={rows.length === 0}
              onClick={() =>
                download(
                  `edmund-credits-${new Date().toISOString().slice(0, 10)}.csv`,
                  csvFor(rows, tz),
                )
              }
            >
              <DownloadIcon className="size-3.5" />
              <span className="hidden sm:inline">CSV</span>
            </Button>
          </span>
        </span>
      }
      description={
        summary ??
        "Every generation on your key with what it cost, every payment, and your credit after each line. Read from OpenRouter and Stripe when you open this page."
      }
      padded={false}
    >
      {available.length > 2 ? (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-3 pt-1 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden">
          {available.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFilter(f.id);
                setShown(PAGE);
              }}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
                filter === f.id
                  ? "border-ink bg-ink text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="pt-1" />
      )}

      {state.kind === "error" ? (
        <div className="px-4 pb-5 sm:px-5">
          <p className="text-[14px] text-muted-foreground">{state.message}.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[6.5rem]">Date</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead className="hidden md:table-cell">Model</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.kind === "loading" ? (
              ["a", "b", "c"].map((k) => (
                <TableRow key={k} className="hover:bg-transparent">
                  <TableCell>
                    <Skeleton className="h-3.5 w-12" />
                    <Skeleton className="mt-1.5 h-3 w-14" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="mt-1.5 h-3 w-40" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Skeleton className="h-3.5 w-44" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-3.5 w-14" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-3.5 w-12" />
                  </TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {rows.length === 0 ? "No generations yet." : "Nothing of that kind."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map(({ key, r }) => <ActivityLine key={key} r={r} tz={tz} />)
            )}
          </TableBody>
        </Table>
      )}

      {state.kind === "ready" && filtered.length > shown ? (
        <div className="border-t border-border/70 px-4 py-3 sm:px-5">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[13px]"
            onClick={() => setShown((n) => n + PAGE)}
          >
            Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length}
          </Button>
        </div>
      ) : null}

      <p className="px-4 pb-4 pt-3 text-[12.5px] leading-relaxed text-muted-foreground sm:px-5">
        Cost and time are OpenRouter's record of each generation. Balance is your credit after that
        line, worked back from what OpenRouter reports now. A time shown as "about" is the hour
        OpenRouter filed it under.
        {state.kind === "ready" && !state.activity.complete
          ? " Part of the history could not be read just now; refresh to try again."
          : ""}
      </p>
    </Paper>
  );
}

function ActivityLine({ r, tz }: { r: PortalActivityRow; tz: string }) {
  const refused = isRefusal(r);
  const credit = isCredit(r);
  return (
    <TableRow>
      <TableCell>
        <div className="whitespace-nowrap">{fmtDateShort(r.atMs, tz)}</div>
        <div className="whitespace-nowrap text-[12.5px] text-muted-foreground">
          {r.atExact ? fmtTime(r.atMs, tz) : `about ${fmtHour(r.atMs, tz)}`}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{whatLabel(r)}</span>
          {refused ? <Tag tone="warn">refused</Tag> : null}
        </div>
        {r.kind === "generation" && r.model ? (
          <div
            className="mt-0.5 max-w-[11rem] truncate font-mono text-[11.5px] text-muted-foreground md:hidden"
            title={r.model}
          >
            {r.model}
          </div>
        ) : null}
        {refused ? (
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            {REFUSAL[r.kind] ?? "refused"}
            {r.model ? <span className="md:hidden"> · {r.model}</span> : null}
          </div>
        ) : credit && r.detail ? (
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{r.detail}</div>
        ) : null}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {r.model ? (
          <span
            className="block max-w-[16rem] truncate font-mono text-[12px] text-muted-foreground"
            title={r.model}
          >
            {r.model}
          </span>
        ) : r.reference ? (
          <span
            className="block max-w-[16rem] truncate font-mono text-[12px] text-muted-foreground"
            title={r.reference}
          >
            {r.reference}
          </span>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>
      <TableCell
        className={cn(
          "tnum whitespace-nowrap text-right",
          credit && "text-emerald",
          refused && "text-muted-foreground/60",
        )}
      >
        {credit ? `+${money(r.creditUsd)}` : r.costUsd !== null ? `−${moneyExact(r.costUsd)}` : "—"}
      </TableCell>
      <TableCell className="tnum whitespace-nowrap text-right">
        {money(r.balanceAfterUsd)}
      </TableCell>
    </TableRow>
  );
}
