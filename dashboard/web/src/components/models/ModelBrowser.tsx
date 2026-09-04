import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  type ORModel,
  fmtContext,
  fmtPrice,
  getInputModalities,
  inputPriceNum,
  isFree,
  labDisplayName,
  labFromId,
  modelDate,
  outputPriceNum,
  supportsTools,
} from "@/features/models/useModels";
import { cn } from "@/lib/cn";
import { type ReactNode, useMemo, useState } from "react";

// The full OpenRouter catalog browser — search, lab/modality/context filters
// and sortable pricing columns.

type SortKey = "input_price" | "output_price" | "context" | "date" | "name";

const MODALITY_FILTERS = [
  {
    key: "vision",
    label: "Vision",
    check: (m: ORModel) => getInputModalities(m).includes("image"),
  },
  { key: "audio", label: "Audio", check: (m: ORModel) => getInputModalities(m).includes("audio") },
  { key: "video", label: "Video", check: (m: ORModel) => getInputModalities(m).includes("video") },
  { key: "files", label: "Files", check: (m: ORModel) => getInputModalities(m).includes("file") },
  { key: "tools", label: "Tools", check: supportsTools },
  { key: "free", label: "Free", check: isFree },
];

const CONTEXT_FILTERS = [
  { key: "8k", label: "8K+", min: 8_000 },
  { key: "32k", label: "32K+", min: 32_000 },
  { key: "128k", label: "128K+", min: 128_000 },
  { key: "200k", label: "200K+", min: 200_000 },
  { key: "1m", label: "1M+", min: 1_000_000 },
];

export function ModelBrowser(props: {
  models: ORModel[];
  isLoading: boolean;
  /** Model id rendered as the current selection. */
  selectedId?: string;
  /** Row-action button text ("Use", "Select"). */
  actionLabel?: string;
  /** Badge text on the selected row ("fallback", "selected"). */
  selectedBadge?: string;
  onSelect?: (id: string) => void;
  selecting?: boolean;
  /** Pre-enable modality filter chips (e.g. ["tools"] when picking a conversation model). */
  initialModalities?: string[];
  /** Constrain the table region's height (the filter bar stays put). */
  tableMaxHeight?: string;
}) {
  const {
    models,
    isLoading,
    selectedId = "",
    actionLabel = "Select",
    selectedBadge = "selected",
    onSelect,
    selecting = false,
    initialModalities = [],
    tableMaxHeight,
  } = props;

  const [search, setSearch] = useState("");
  const [labFilter, setLabFilter] = useState<string>("");
  const [modalities, setModalities] = useState<Set<string>>(new Set(initialModalities));
  const [contextFilter, setContextFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("input_price");
  const [sortAsc, setSortAsc] = useState(true);

  const labs = useMemo(() => {
    const set = new Set(models.map((m) => labFromId(m.id)));
    return [...set].sort((a, b) => labDisplayName(a).localeCompare(labDisplayName(b)));
  }, [models]);

  const filtered = useMemo(() => {
    let list = models.filter((m) => {
      if (search) {
        const q = search.toLowerCase();
        if (!m.id.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) return false;
      }
      if (labFilter && labFromId(m.id) !== labFilter) return false;
      if (modalities.size > 0) {
        for (const key of modalities) {
          const f = MODALITY_FILTERS.find((x) => x.key === key);
          if (f && !f.check(m)) return false;
        }
      }
      if (contextFilter) {
        const cf = CONTEXT_FILTERS.find((x) => x.key === contextFilter);
        if (cf && m.context_length < cf.min) return false;
      }
      return true;
    });

    list = list.sort((a, b) => {
      let diff = 0;
      if (sortKey === "input_price") diff = inputPriceNum(a) - inputPriceNum(b);
      else if (sortKey === "output_price") diff = outputPriceNum(a) - outputPriceNum(b);
      else if (sortKey === "context") diff = (b.context_length ?? 0) - (a.context_length ?? 0);
      else if (sortKey === "date") diff = (b.created ?? 0) - (a.created ?? 0);
      else if (sortKey === "name") diff = a.name.localeCompare(b.name);
      return sortAsc ? diff : -diff;
    });

    return list;
  }, [models, search, labFilter, modalities, contextFilter, sortKey, sortAsc]);

  function toggleModality(key: string) {
    setModalities((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function setSort(key: SortKey) {
    if (sortKey === key) setSortAsc((x) => !x);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card>
        <CardBody className="space-y-3 py-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="w-64">
              <Input
                placeholder="Search models..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <select
              value={labFilter}
              onChange={(e) => setLabFilter(e.target.value)}
              className="bg-card border border-border rounded-md px-3 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All labs</option>
              {labs.map((lab) => (
                <option key={lab} value={lab}>
                  {labDisplayName(lab)}
                </option>
              ))}
            </select>

            <div className="flex gap-1 flex-wrap">
              {MODALITY_FILTERS.map((f) => (
                <Chip
                  key={f.key}
                  active={modalities.has(f.key)}
                  onClick={() => toggleModality(f.key)}
                >
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-xs text-muted mr-1">Context:</span>
            <Chip active={contextFilter === ""} onClick={() => setContextFilter("")}>
              Any
            </Chip>
            {CONTEXT_FILTERS.map((f) => (
              <Chip
                key={f.key}
                active={contextFilter === f.key}
                onClick={() => setContextFilter(f.key)}
              >
                {f.label}
              </Chip>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Table */}
      {isLoading ? (
        <p className="text-sm text-muted">Loading models…</p>
      ) : (
        <Card>
          <div
            className={cn("overflow-x-auto", tableMaxHeight && "overflow-y-auto")}
            style={tableMaxHeight ? { maxHeight: tableMaxHeight } : undefined}
          >
            <table className="w-full text-sm">
              <thead className={cn(tableMaxHeight && "sticky top-0 bg-card z-10")}>
                <tr className="border-b border-border">
                  <Th className="pl-4 w-[380px]">
                    <SortBtn
                      active={sortKey === "name"}
                      asc={sortAsc}
                      onClick={() => setSort("name")}
                    >
                      Model
                    </SortBtn>
                  </Th>
                  <Th>
                    <SortBtn
                      active={sortKey === "context"}
                      asc={sortAsc}
                      onClick={() => setSort("context")}
                    >
                      Context
                    </SortBtn>
                  </Th>
                  <Th>
                    <SortBtn
                      active={sortKey === "input_price"}
                      asc={sortAsc}
                      onClick={() => setSort("input_price")}
                    >
                      Input
                    </SortBtn>
                  </Th>
                  <Th>
                    <SortBtn
                      active={sortKey === "output_price"}
                      asc={sortAsc}
                      onClick={() => setSort("output_price")}
                    >
                      Output
                    </SortBtn>
                  </Th>
                  <Th>Capabilities</Th>
                  <Th>
                    <SortBtn
                      active={sortKey === "date"}
                      asc={sortAsc}
                      onClick={() => setSort("date")}
                    >
                      Added
                    </SortBtn>
                  </Th>
                  {onSelect ? <Th className="pr-4 text-right">Action</Th> : null}
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    isSelected={m.id === selectedId}
                    selectedBadge={selectedBadge}
                    actionLabel={actionLabel}
                    onSelect={onSelect}
                    selecting={selecting}
                  />
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={onSelect ? 7 : 6}
                      className="px-4 py-8 text-center text-sm text-muted"
                    >
                      No models match filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Row + small helpers ──────────────────────────────────────────────────────

function ModelRow({
  model: m,
  isSelected,
  selectedBadge,
  actionLabel,
  onSelect,
  selecting,
}: {
  model: ORModel;
  isSelected: boolean;
  selectedBadge: string;
  actionLabel: string;
  onSelect?: (id: string) => void;
  selecting: boolean;
}) {
  const free = isFree(m);
  const inputMods = getInputModalities(m);
  const tools = supportsTools(m);

  return (
    <tr
      className={cn(
        "border-b border-border/50 last:border-0 group",
        isSelected ? "bg-accent/5 hover:bg-accent/10" : "hover:bg-card/60",
      )}
    >
      {/* Name */}
      <td className="pl-4 pr-3 py-2.5">
        <div className="flex items-start gap-2.5">
          {isSelected && <span className="mt-0.5 text-accent text-xs">&#9679;</span>}
          <div className={cn(!isSelected && "pl-3.5")}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-fg leading-tight">{m.name}</span>
              {isSelected && (
                <Badge tone="accent" className="text-[10px] px-1.5 py-0">
                  {selectedBadge}
                </Badge>
              )}
              {free && (
                <Badge tone="ok" className="text-[10px] px-1.5 py-0">
                  FREE
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted font-mono mt-0.5 truncate max-w-[330px]">
              {m.id}
            </div>
          </div>
        </div>
      </td>

      {/* Context */}
      <td className="px-3 py-2.5 text-right">
        <span className="text-xs font-mono text-fg">
          {m.context_length ? fmtContext(m.context_length) : "—"}
        </span>
      </td>

      {/* Input price */}
      <td className="px-3 py-2.5 text-right">
        <PriceCell raw={m.pricing.prompt} />
      </td>

      {/* Output price */}
      <td className="px-3 py-2.5 text-right">
        <PriceCell raw={m.pricing.completion} />
      </td>

      {/* Capabilities */}
      <td className="px-3 py-2.5">
        <div className="flex gap-1 flex-wrap">
          {inputMods.includes("image") && <CapBadge label="Vision" />}
          {inputMods.includes("audio") && <CapBadge label="Audio" />}
          {inputMods.includes("video") && <CapBadge label="Video" />}
          {inputMods.includes("file") && <CapBadge label="Files" />}
          {tools && <CapBadge label="Tools" accent />}
        </div>
      </td>

      {/* Date */}
      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">{modelDate(m)}</td>

      {/* Action */}
      {onSelect ? (
        <td className="pr-4 pl-2 py-2.5 text-right">
          {isSelected ? (
            <span className="text-xs text-accent font-medium">Selected</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={selecting}
              onClick={() => onSelect(m.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-xs"
            >
              {actionLabel}
            </Button>
          )}
        </td>
      ) : null}
    </tr>
  );
}

function PriceCell({ raw }: { raw: string }) {
  const formatted = fmtPrice(raw);
  return (
    <span
      className={cn(
        "text-xs font-mono",
        formatted === "FREE" ? "text-ok" : formatted === "Varies" ? "text-muted italic" : "text-fg",
      )}
    >
      {formatted}
    </span>
  );
}

function CapBadge({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0 text-[10px] font-medium",
        accent ? "bg-accent/15 text-accent" : "bg-border/60 text-muted",
      )}
    >
      {label}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
        active
          ? "bg-accent text-white"
          : "bg-card border border-border text-muted hover:text-fg hover:border-muted",
      )}
    >
      {children}
    </button>
  );
}

function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-muted font-semibold whitespace-nowrap",
        className,
      )}
    >
      {children}
    </th>
  );
}

function SortBtn({
  active,
  asc,
  onClick,
  children,
}: {
  active: boolean;
  asc: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-0.5 uppercase tracking-wider text-[10px] font-semibold transition-colors",
        active ? "text-fg" : "text-muted hover:text-fg",
      )}
    >
      {children}
      {active && <span className="ml-0.5">{asc ? "↑" : "↓"}</span>}
    </button>
  );
}
