# Memory architecture research — 2026-07-28

Commissioned before Phase 4 (memory architecture) of the improvement roadmap.
Four parallel research sweeps: production systems, chunking/embeddings,
retrieval quality, episodic/profile patterns. Raw agent reports below;
synthesis + implications for edmund-harness at the end.

---

## Report 4 — Episodic memory, consolidation, and person-profile patterns

# Episodic Memory, Consolidation, and Person-Profiles in Long-Running Assistant Agents — State of Practice through 2026

## 1. Hierarchical / episodic summarization

**What the LongMemEval authors themselves found** ([LongMemEval, arXiv 2410.10813](https://arxiv.org/pdf/2410.10813), [project site](https://xiaowu0162.github.io/long-mem-eval/)): the benchmark tests five abilities (information extraction, multi-session reasoning, knowledge updates, temporal reasoning, abstention) and long-context LLMs drop 30–60% on it. Their unified framework (indexing → retrieval → reading) yields four evidence-backed rules:

- **Granularity: round-level (one user-assistant exchange) beats both session-level and fact-level compression** as the storage unit — mid-granularity preserves context without burying the signal.
- **Fact-augmented key expansion** (index each round under both its text and LLM-extracted user facts) → +4% recall, +5% QA accuracy.
- **Time-aware indexing + query expansion** → +7–11% recall on temporal reasoning.
- **Structured reading** (Chain-of-Note, JSON formatting) → +10pp reading accuracy.

**Independent confirmation that granularity is the lever:** [SeCom (arXiv 2502.05589)](https://arxiv.org/html/2502.05589v3) shows topical **segment-level memory beats both turn-level and session-level**; segments are cut at topic shifts. [MemGAS (arXiv 2505.19549)](https://arxiv.org/html/2505.19549) goes further: index at **multiple granularities simultaneously** (turn, session, summary, keyword) and route queries to the right one — no single granularity wins for all query types. [HiMem (arXiv 2601.06377)](https://arxiv.org/pdf/2601.06377) formalizes episodes as structured records (id, timestamp, topic, topic summary, dialogue span) with boundaries at **topical shifts or salient discontinuities** (intent/emotional-state changes).

**The current LongMemEval leader is not RAG at all.** [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) (94.87% with gpt-5-mini; 84.23% gpt-4o — beating the 82.4% *oracle* that only sees answer-containing sessions) uses an **Observer** agent that compresses raw messages into dense, *dated*, priority-tagged observations (3–6× compression) and a **Reflector** that periodically condenses the observation log. Key design lessons they state: chronological append-only observation logs beat vector retrieval; **each observation carries up to three dates** (observed, referenced, relative) for temporal reasoning; static prefix context enables prompt caching (4–10× cost cut). Per the [OMEGA leaderboard](https://omegamax.co/benchmarks): OMEGA 95.4%, Mastra 94.87%, [Hindsight 91.4%](https://arxiv.org/pdf/2512.12818), [Mem0's 2026 pipeline 93.4%](https://preuve.ai/blog/ai-memory-systems-statistics-2026) (up from 49%), Supermemory 81.6%, Zep/Graphiti 71.2%.

**Takeaway:** session → episode → periodic summaries works, but the winning granularity is *event/observation-level entries with explicit dates*, kept in chronological order, periodically re-condensed — not big opaque session summaries and not atomized facts.

## 2. Reflection / consolidation — does offline consolidation beat write-time extraction?

**Yes, measurably, across several independent lines:**

- **Generative Agents** ([Park et al. 2023](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)) established the pattern: a **memory stream** of timestamped observations, retrieval scored `recency + importance + relevance` (exponential recency decay, LLM-scored importance, embedding relevance), and **reflection triggered when summed importance of recent events exceeds a threshold (150)**: the agent generates salient questions, answers them from retrieved memories, and stores the insights *with pointers to the evidence memories* — a **reflection tree** whose leaves are observations and whose internal nodes are inferences. Ablations showed removing reflection degraded behavior believability.
- **Letta's sleep-time compute** ([paper + blog](https://www.letta.com/blog/sleep-time-compute/), [GitHub](https://github.com/letta-ai/sleep-time-compute)): a dual-agent design — the primary agent *cannot edit its own core memory*; a **sleep-time agent** runs during idle periods, converting **raw context into "learned context"** by rewriting shared memory blocks (`rethink_memory`). Explicit motivation: MemGPT-style incremental self-editing "became messy and disorganized over time." Results show a Pareto improvement (quality at lower interaction-time latency/cost).
- **[Hindsight (arXiv 2512.12818)](https://arxiv.org/pdf/2512.12818)** — retain / recall / **reflect** — attributes its 91.4% LongMemEval score largely to the offline reflect stage: pattern extraction, contradiction reconciliation, dedup, and entity-profile construction happen post-hoc, not at write time.
- **Mastra's Reflector** (above) is periodic consolidation; **[Mem0 (arXiv 2504.19413)](https://arxiv.org/html/2504.19413v1)** went the other way — its old two-pass write-time reconciliation (ADD/UPDATE/DELETE) was found to be where "cost and latency lived, and where a bad reconciliation could silently delete a fact you wanted" ([Mem0's own testing writeup](https://mem0.ai/blog/how-to-test-ai-agent-memory-with-mem0-a-practical-memory-simulation-guide)); the 2026 redesign is **single-pass ADD-only at write time** with reconciliation deferred — i.e., even the flagship write-time-extraction vendor moved destructive operations *out* of the write path.
- **[A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)** shows a middle form: each new Zettelkasten-style note triggers **memory evolution** — neighbors get their context/tags/links updated — outperforming static-store baselines across six models.

**Takeaway:** write-time extraction alone is the weakest configuration in every comparison found. The strongest systems do *cheap, non-destructive capture at write time* plus *periodic LLM-driven reorganization offline*, and specifically forbid destructive edits in the hot path.

## 3. Person / entity profile patterns

- **Letta/MemGPT "human" block** ([Letta memory blocks docs](https://docs.letta.com/guides/core-concepts/memory/memory-blocks), [blog](https://www.letta.com/blog/memory-blocks/)): the profile is a **labeled, size-capped, always-in-context text block** (default **2,000 characters**, hard-enforced — exceeding it throws), separate from the `persona` block, with archival/recall storage behind search. What's *in* the block: durable facts and preferences the agent decided matter; everything else stays retrievable.
- **ChatGPT in production** ([Rehberger's reverse-engineering deep dive](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/), [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)): six injected sections — **Model Set Context** (explicit saved memories, each *timestamped*), **Assistant Response Preferences** (~15 inferred entries, each with a **confidence tag**), **Notable Past Conversation Topic Highlights** (~8 summaries), **Helpful User Insights** (~14 profile entries), **Recent Conversation Content** (~40 recent conversation summaries, **user messages only** — the author believes assistant turns are excluded partly to limit injection/hallucination propagation), and User Interaction Metadata. These are generated **out-of-band on a regular cadence** (offline batch consolidation, confirmed by the author's tests showing ChatGPT *cannot* live-search history). So production-scale profile maintenance = bounded, sectioned, timestamped, confidence-tagged, offline-refreshed.
- **Zep/Graphiti** ([arXiv 2501.13956](https://arxiv.org/html/2501.13956v1), [Graphiti](https://www.getzep.com/platform/graphiti/)) is the reference for **staleness/contradiction**: bi-temporal edges (event time vs ingestion time; `valid_at`/`invalid_at` plus when-learned/when-learned-invalid). A new fact ("switched Starter→Enterprise") **closes the old edge's validity window and opens a new edge — nothing is deleted**; an LLM compares new edges against semantically related existing edges to detect temporally-overlapping contradictions and invalidates (not removes) the losers. Full history stays queryable.
- Mem0's finding on contradiction handling is cautionary: **prompt-level "resolve contradictions" instructions change behavior but "not predictably enough to be the primary mechanism"** — the reliable design is accumulating the full sequence of preference changes and resolving "current value" at read time ([Mem0 blog](https://mem0.ai/blog/how-to-test-ai-agent-memory-with-mem0-a-practical-memory-simulation-guide)).

## 4. The two-tier pattern (small always-injected core + searchable archive)

Everyone who runs long-lived assistants converges on it:

| System | Core (always in context) | Core size | Archive | Promotion/demotion decided by |
|---|---|---|---|---|
| [MemGPT/Letta](https://www.emergentmind.com/topics/memgpt) | labeled memory blocks (`human`, `persona`, task) | **2,000 chars/block default** | recall (conversation) + archival (vector) storage | the agent itself via memory-edit tools; in sleep-time mode, **only the offline agent may edit core** |
| [ChatGPT](https://help.openai.com/en/articles/8590148-memory-faq) | Model Set Context + inferred-preference/insight sections | ~15 entries/section, bounded ("memory full" exists) | chat history (offline-summarized; not live-searchable per [Rehberger](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)) | explicit user saves + offline batch inference with confidence tags |
| Claude Code / [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | `MEMORY.md` injected into system prompt every session | instructed to stay **concise, link out to detail files** | additional files in the memory directory, read on demand | the model, per prompt guidance ("promote what recurs, link details") |
| [Mastra OM](https://mastra.ai/research/observational-memory) | observation log prefix (compressed, cacheable) | token-threshold-bounded; Reflector shrinks it | replaced raw messages (recoverable) | Observer promotes events; Reflector merges/demotes by redundancy and priority tags |
| [Generative Agents](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) | retrieved top-k each step (no static core) | — | full memory stream, never deleted | score = recency×importance×relevance; reflections outrank raw observations via importance |

Promotion signals in practice: **explicit user request, repetition across sessions, high LLM-scored importance, access frequency** ([MemGPT analyses](https://www.emergentmind.com/topics/memgpt) describe frequency/importance-driven promotion-demotion analogous to cache hierarchies). Demotion: redundancy after merge, size-cap pressure, staleness — always *to the archive*, not to deletion, in the well-regarded designs.

## 5. Forgetting without losing

- **Invalidate, don't delete** — Zep's `invalid_at` supersession (above) is the cleanest published pattern: newer fact wins at read time, history retained with provenance of when-learned and when-superseded.
- **Decay strength, not existence** — [MemoryBank (arXiv 2305.10250)](https://arxiv.org/abs/2305.10250) applies Ebbinghaus-style exponential decay to a *retrieval-strength* score, **reinforced on each recall**; low-strength items become hard to surface but still exist. Successors extend to multi-dimensional intensity (emotion, novelty, frequency) ([ACM 2026](https://dl.acm.org/doi/full/10.1145/3803291.3803294)).
- **Merge instead of drop** — A-MEM's memory evolution updates neighbors' context/tags/links when near-duplicates arrive; Mastra's Reflector "combines related items, identifies patterns, removes redundant content" from the *log* (compression, with the underlying record replaced rather than lost); Hindsight dedups during reflect.
- **Never let an LLM hard-delete in the write path** — Mem0's documented silent-deletion failure of write-time DELETE ops is the canonical argument; their fix (ADD-only writes, read-time resolution over the full preference sequence) preserved recall while restoring current-state accuracy.
- Generative Agents keep the **entire stream forever** and rely purely on retrieval scoring — proof that "forgetting" can live entirely in the ranking function.

## 6. Failure modes documented in the wild, and guards

1. **Memory poisoning / persistence attacks.** [SpAIware](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/) (Rehberger, 2024): indirect prompt injection from a webpage/doc writes a *memory* that exfiltrates all future chats — the injection outlives the session; he even demoed C2-style remote instruction updates. [MINJA (arXiv 2601.05504)](https://arxiv.org/abs/2601.05504) shows >95% injection success via query-only interaction; [sleeper poisoning (arXiv 2605.15338)](https://arxiv.org/html/2605.15338v2) and [MemPoison](https://arxiv.org/html/2607.14651v1) show **write-time filters fail against dormant/compositional payloads**; [MemGhost (2026)](https://thehackernews.com/2026/07/new-memghost-attack-plants-persistent.html) plants persistent false memories from one email. *Guards:* treat memory writes from turns containing untrusted content as tainted; provenance binding on every record; retrieval-time checking (not only write-time); user-visible "memory updated" notifications (OpenAI's mitigation); never store imperative/instruction-shaped text as memory.
2. **Stale-memory override.** [Longitudinal-risk study (arXiv 2605.17830)](https://arxiv.org/html/2605.17830): stale memories **override in-conversation corrections**; violation rates *rise monotonically with exposure length*; broad semantic retrieval and aggressive summarization steepen the curve, recency-biased verbatim retrieval flattens it. *Guards:* timestamps on everything, recency-weighted retrieval, retrieval-time monitor (0.97+ recall at predicting violations) with fallback to memoryless generation.
3. **Summarization-combination / composite claims.** Same paper: merged summaries assert things **no single source supports**. *Guard:* keep provenance links from summaries to source episodes (Generative Agents' reflection→evidence pointers); prefer event-level observations over broad summaries.
4. **Over-injection changing persona/behavior.** Rehberger documents that ChatGPT's inferred preference sections with high-confidence tags "could steer the model into a certain direction," makes behavior non-reproducible across accounts. OpenAI's [sycophancy postmortem](https://openai.com/index/expanding-on-sycophancy/) explicitly flagged that user-specific signals (including memory) can amplify unintended behavior over time. Attention dilution (safety/persona instructions losing traction as memory grows) is documented in [arXiv 2605.17830](https://arxiv.org/html/2605.17830). *Guards:* hard size budgets on injected memory; keep persona in the system prompt, **never derived from memory**; separate "facts about the user" from "how to behave."
5. **Feedback loops — the agent remembering its own confabulations.** Rehberger observed ChatGPT **hallucinating memories into Model Set Context from other injected sections**. [Honest Lying (arXiv 2605.29463)](https://arxiv.org/html/2605.29463) and [HaluMem](https://www.researchgate.net/publication/397322313_HaluMem_Evaluating_Hallucinations_in_Memory_Systems_of_Agents) study self-reinforcing error: a false stored conclusion ("API X always fails with Y") is never re-tested; retrieved hallucinations spuriously corroborate new ones, inflating confidence. *Guards:* store user statements and tool-verified facts preferentially over agent inferences; mark inferences as inferences with confidence; ChatGPT's "user messages only" in Recent Conversation Content is a production instance of excluding assistant output from the memory substrate.
6. **Cross-context leakage** — memory from one task/party surfacing in another ([arXiv 2605.17830](https://arxiv.org/html/2605.17830)). *Guard:* scope/namespace memories (per-person, per-project) and filter retrieval by scope.

## Concrete design rules for a personal assistant that must NEVER regress its recall or personality

**Tier 0 — invariants (violating these is how systems regress):**
1. **Never hard-delete; supersede.** Every "update" closes a validity window (`valid_from`/`invalid_from` + when-learned) and writes a new record — Zep's pattern. "Forgetting" is only ever demotion (lower retrieval strength / move out of core), never removal.
2. **No destructive LLM operations in the write path.** Capture is append-only and cheap (Mem0 learned this the hard way — write-time DELETE silently ate wanted facts). All merging, contradiction resolution, and demotion happen in a *reviewable offline pass*.
3. **Persona is config, not memory.** The personality definition lives in the system prompt under version control; memory may *inform* tone ("Edmund likes brevity") but can never rewrite the persona block. This single rule prevents both over-injection drift and poisoning of personality.
4. **Provenance on every record:** source turn/session id, timestamp, and origin class (`user-stated` > `tool-verified` > `agent-inferred`), with confidence on inferences. Summaries/reflections keep pointers to their evidence records so composite claims are auditable.

**Tier 1 — architecture:**
5. **Two tiers with a hard core budget.** Always-injected core = structured profile blocks (person, preferences, active projects), each size-capped (~2k chars/block per Letta; ChatGPT keeps ~15 entries/section). Everything else in a searchable archive. When the core is full, the *offline* pass merges/demotes — never silent truncation.
6. **Store at event/observation granularity with explicit dates,** not whole-session blobs and not atomized context-free facts (LongMemEval: round-level wins; Mastra: dated observations beat the oracle). Record observation date *and* referenced date ("dentist next Tuesday" needs both).
7. **Run a nightly/idle consolidation agent** (sleep-time pattern): dedup and merge near-duplicates, reconcile contradictions via supersession, refresh profile blocks, promote recurring facts to core, demote stale ones — and make the primary agent *unable* to edit core directly, so consolidation is the single audited writer.
8. **Resolve "current truth" at read time** from the full history (latest valid record wins; history available on request), rather than trusting any single stored "current value."
9. **Index for retrieval three ways:** verbatim text, extracted-fact keys (+4–5% per LongMemEval), and time (+7–11% on temporal queries); bias retrieval toward recency to blunt stale-override.

**Tier 2 — safety of the loop:**
10. **Taint and quarantine untrusted-source writes.** Any memory formed in a turn containing web/email/document content is flagged and either blocked from core or held for the offline pass with its source attached (SpAIware/MINJA/MemGhost defense). Never store instruction-shaped text.
11. **Prefer remembering what the user said and what tools verified over what the assistant concluded**; exclude or downweight assistant-generated prose as memory source material (ChatGPT stores user messages only in its history section) — this breaks the confabulation feedback loop.
12. **Surface every core-memory change to the user** ("memory updated: …") and keep the core human-readable and human-editable — the only proven recovery path from drift and poisoning.
13. **Monitor at retrieval time, not just write time** (write-time filters demonstrably fail against dormant payloads): a cheap check on retrieved items with fallback to memoryless answering, plus periodic regression tests — a fixed probe set of "what do you know about me / what's my current X" questions whose answers must never get worse after consolidation runs. Gate every consolidation deploy on that probe suite.

---

## Report 2 — Chunking & embedding practices

(Full report 2 text follows.)

# Chunking & Embedding for Conversational + Personal-Document Retrieval — Evidence Review (through mid-2026)

## 1. Optimal chunk size, chunking method, and overlap

**Chunk size — strong evidence.** Multiple independent empirical lines converge on **~200–512 tokens** for retrieval precision:

- Chroma's token-level chunking evaluation (trychroma.com/research/evaluating-chunking) tested 200–800-token chunks with 0–400-token overlaps. Best balance: **~200-token chunks, no overlap** — RecursiveCharacterTextSplitter at 200/0 got 88.1% recall at 7.0% precision. The often-copied OpenAI default (800 tokens, 400 overlap) had similar recall (87.9%) but **1.4% precision/IoU** — 5x worse token efficiency.
- Survey/benchmark roundups (Firecrawl 2026, Ailog) report 256–512 tokens best for factoid queries, 1024+ only for analytical/synthesis queries; missing the right bracket by one step degrades context precision 15–30%.
- Vectara NAACL 2025 (arxiv.org/abs/2410.13070) across 48 embedding models: **chunking configuration influences retrieval quality as much as or more than embedding-model choice**.

**Fixed vs semantic vs recursive:** semantic chunking only won on *artificially stitched* multi-topic documents; on natural documents fixed-size matched or beat it. *"Fixed-size chunking remains a more efficient and reliable choice for practical RAG applications."* **The practical winner is structure-aware splitting (headings, message boundaries) with a fixed size cap — not embedding-based semantic chunking.**

**Overlap:** removing overlap *improved* IoU/precision dramatically with essentially no recall loss. Overlap's only defensible role is insurance against facts straddling boundaries when splitting mid-prose with no structural signal.

**Recommendation:** target **200–400 tokens (~800–1,600 chars)**, hard cap ~512 tokens (~2,000 chars); split on structural boundaries first, size second; **0 overlap when boundaries are structural; 10–15% only for unstructured prose**.

## 2. Anthropic Contextual Retrieval — numbers and cheap approximations

Published numbers (anthropic.com/engineering/contextual-retrieval), failure = 1 − recall@20, baseline 5.7%: contextual embeddings alone → 3.7% (−35%); + contextual BM25 hybrid → 2.9% (−49%); + reranking → 1.9% (−67%). Mechanics: 50–100 tokens of chunk-situating context prepended before embedding AND before BM25 indexing; chunks "no more than a few hundred tokens"; retrieve top-20.

**The cheap version is the high-ROI version.** The LLM-generated context largely recovers *document identity + section location*. For personal documents that metadata is already known, so a deterministic header — doc title, section path, date, participants — captures much of the −35% without any LLM calls. Apply the header to the BM25/keyword index too, not just vectors (hybrid contributes a further large slice: −35% → −49%).

## 3. Late chunking and other innovations

Late chunking (Jina): real but modest, model-dependent, conflicting evidence vs contextual retrieval; **requires an 8K mean-pooling model — impossible with MiniLM/bge-small**. For chat logs and profile files whose natural chunks are already self-contained, expect ~0 gain. **Skip it; header-prefixing is the better ROI.** Multi-granularity indexing (AI21 query-dependent chunking, Mix-of-Granularity) has decent support and maps well onto chat data.

## 4. Local embedding models for transformers.js in 2026

**MiniLM-L6-v2 is the weakest link you can most cheaply fix.** MTEB Retrieval (nDCG@10): MiniLM-L6-v2 **41.95** vs **51.68** bge-small-en-v1.5 vs **51.98** snowflake-arctic-embed-s — a ~10-point gap from models in the **same 384-dim, 33M-param, same-speed class**. MiniLM's 256-token window silently truncates and caps chunk size below the optimum.

| Model | Params | Dims | Window | MTEB Retrieval | Prefix |
|---|---|---|---|---|---|
| all-MiniLM-L6-v2 | 23M | 384 | 256 | 41.95 | none |
| **bge-small-en-v1.5** | 33M | 384 | 512 | 51.68 | query-only |
| **snowflake-arctic-embed-s** | 33M | 384 | 512 | 51.98 | query-only |
| gte-small | 33M | 384 | 512 | ~49.5 | none |
| nomic-embed-text-v1.5 | 137M | 768 | 8192 | ~53 | both sides |
| EmbeddingGemma-300m | 308M | 768 (MRL) | 2048 | best <500M | task prompts |

MiniLM measures 8–12ms/sentence on M2 under WASM; bge-small/arctic-s land in the same ~10–20ms class; q8 ONNX ~25–35 MB. **Recommendation: switch to bge-small-en-v1.5 (or arctic-embed-s)** — same dims/speed, +10 nDCG, 512-token window; remember the query-side prefix and full re-embed on migration.

## 5. Chat-specific chunking

- **LongMemEval**: round-level (user turn + reply) wins — up to +6% QA over whole-session; decomposing into extracted facts *hurts*. Fact-augmented keys +4% recall / +5% QA. Time-aware indexing + query expansion **+7–11% on temporal questions**.
- **SeCom** (Microsoft, ICLR 2025): turn-level too fragmented, session-level too noisy; **topically coherent segments** (a few consecutive turns) beat both.
- **Primary unit: round/topical segment** — 1–5 consecutive messages on one topic, 100–400 tokens. Never embed a whole session as one vector; drop or merge no-signal turns (greetings/acks).
- **Speaker attribution in chunk text: yes** (`Name: …` per line). **Timestamps: metadata first, text second** — ISO timestamp as filterable metadata for range queries + recency scoring; short human-readable header line (`[2026-03-14, iMessage with X]`) in the chunk text so BM25 can hit "March" and the reading LLM sees when.

## 6. Long personal profile documents (markdown, sections + dated bullets)

- **Section-aware chunking**: split on heading boundaries; token-cap splitting that crosses sections mixes topics and dilutes the embedding.
- **Heading-path breadcrumb prefix in every chunk**: `Doc title > H2 > H3` as first line, in embedded text + BM25 — the free static version of contextual retrieval. ~10–25 tokens per chunk. No downside reported.
- **Oversized sections**: sub-split at bullet/paragraph boundaries into 200–400-token chunks, each repeating the breadcrumb. **Never split a dated bullet**; group consecutive tiny bullets rather than one vector per 8-word bullet.
- **Tiny sections**: merge with parent heading rather than emitting sub-50-token chunks.

## Concrete parameter sheet

| Parameter | Recommendation |
|---|---|
| Chunk size (docs) | 200–400 tok / 800–1,600 chars, hard cap 512 tok / ~2,000 chars |
| Chunk size (chat) | round/topical segment, 100–400 tok, 1–5 messages |
| Overlap | 0 on structural splits; 10–15% only for unstructured prose |
| Method | structure-aware fixed-cap; skip semantic + late chunking |
| Header (docs) | `{Doc} > {H2} > {H3}` first line, embedded + BM25 |
| Header (chat) | `[{human date}, {participants}]` first line; `Speaker:` per line |
| Timestamps | ISO as filterable metadata + query-time range expansion |
| Retrieval depth | top-10–20 candidates into rerank/LLM, not top-3 |
| Hybrid | dense + BM25 (headers in both) |
| Embedding model | bge-small-en-v1.5 or snowflake-arctic-embed-s (384d, 512-tok, q8 ~30MB) |
| Migration | query prefixes + full re-embed; dims stay 384 |

---

## Report 1 — Production agent-memory systems (synthesis section)

Key verdicts from the systems survey (MemGPT/Letta, mem0, Zep/Graphiti, LangMem, ChatGPT memory teardowns, Anthropic memory tool, Honcho, Mastra, benchmark audits):

**Convergent findings:**
1. **A small, always-in-context, curated profile layer beats retrieval for identity-level facts.** ChatGPT (Model Set Context + User Knowledge), Letta (core blocks ~2k chars), Claude consumer memory, Mastra (observation prefix) all inject a compact curated summary unconditionally. Per-person markdown profiles are exactly this pattern — the single most validated design in the field. Differences are in *how profiles get maintained* (offline consolidation, everywhere).
2. **Verbatim history beats extracted facts.** Controlled ablation (arxiv 2601.00821): verbatim conversation chunks consistently outperform extracted facts/summaries; ConvoMem: full-context beats Mem0-style extraction by 35–40 points below ~150 conversations. Keeping all raw messages indexed is correct; extraction-first pipelines are the field's most instructive overreach.
3. **Agentic, iterative search beats single-shot embedding retrieval.** Letta's 74%-LoCoMo-with-a-filesystem result and Anthropic's memory-tool design both say: the model should search its own memory with tools, reformulate, retry — not just receive top-K injections.
4. **Background consolidation ("sleep-time") is how profiles stay good.** ChatGPT regenerates User Knowledge offline; Letta sleep-time agents; Honcho dream-time; Mastra Reflector. Nobody successful curates profiles only in the hot path.
5. **Temporal modeling is the difference between mediocre and top scores.** Zep bi-temporal edges, Mastra three-date observations; LongMemEval temporal category is where systems gain +20–30 points.
6. **Simple baselines are embarrassingly strong.** Full-context, grep, and filesystem agents beat nearly every specialized memory product. mem0's own graph variant bought ~2%.

**Priority recommendations for this harness:**
1. Automated background profile maintenance with supersede-not-append semantics (have: maintainer; missing: supersession + archive step).
2. **Date-stamp everything injected** — recalled snippets carry timestamp + speaker; profile facts carry as-of dates.
3. **Memory search tool with hybrid vector + SQLite FTS5/BM25 + person/date filters** (MiniLM alone misses exact names/numbers/rare terms; the keyword leg fixes that for near-zero cost).
4. **Recency layer** — inject a compact recent-context block independent of similarity ("continue where we left off" is the most common query shape and similarity misses it).
5. **Contradiction + abstention handling** — similarity floor on auto-recall, provenance labels ("possibly related, may be irrelevant"), precedence rule: dated profile fact > old raw message; newest dated fact wins.
6. **Preserve prompt caching** — order: [persona + profiles (stable)] → [recency block (per conversation)] → [retrieved snippets (per turn)]; never put volatile retrieval above stable content.
7. **Build a tiny private eval (30–50 real questions from own history incl. temporal, updated-fact, and no-answer questions); ignore public leaderboards** (LoCoMo answer key 6.4% wrong, judge accepts 63% of wrong answers; DMR saturated; vendor numbers self-reported).

**Do NOT build:** knowledge graphs (pure overhead at this scale), extraction-replaces-history pipelines, anything justified only by a public benchmark score.

---

## Report 3 — Retrieval quality (key findings)

- **Hybrid dense+BM25 is the single best-evidenced upgrade** (OpSeM, arXiv:2606.04194, controlled): fusion beats BM25 alone in every category; +8.8 to +17.2pp Hit@1 over dense alone. RRF k=60 is robust without tuning (z-normalized weighted sum α≈0.40 on BM25 buys ~3pp more but needs validation). SQLite FTS5 + vectors + RRF is a well-documented pattern.
- **Never mean-pool sessions into one vector** — per-turn/segment embeddings with max-sim aggregation (+13.5 to +23.7pp vs pooled). (Harness already embeds per-message ✓.)
- **Local cross-encoder reranking: OFF by default.** The standard local CE (ms-marco-MiniLM-L-6) *dropped* Hit@1 by 6.9pp on conversational memory — web-trained CEs are out-of-distribution. Never enable without A/B on own queries.
- **Temporal**: time-aware query handling (extract date range → SQL filter) beats time-aware scoring: +6.8–11.3% temporal recall. Dates rendered two ways (ISO in index, human-readable at injection). Event-time vs said-time distinction is what wins knowledge-update categories. Recency/importance as SMALL additive weights (Generative-Agents shape), never hard filters.
- **Query construction**: contextual rewrite of the last message (resolve pronouns from last 2–3 turns) + raw message as second query, RRF-merged. **Skip HyDE** (its gains are parametric-knowledge leakage — can't hallucinate private facts).
- **Injection budget**: context rot is real and distractors compound; related-but-wrong passages are the most damaging content. Top 5–8 memories, ~800–1500 tokens, minimum-score threshold (inject FEWER rather than pad), near-duplicate suppression (cosine >0.9), strongest first, dates visible.
- **Fact-augmented key expansion** (+9.4% recall): index LLM-derived keys (facts/summaries/keywords) pointing back at raw source rows. **Graphs not required** — flat multi-key index matches the best graph schema.
- **Supersession** (mark superseded facts vs blind-add) markedly improves knowledge-update correctness (0.586 vs 0.479).

---

# SYNTHESIS — Phase-4 implementation plan for edmund-harness

Reconciling the four reports with the approved roadmap and the operator's locked design
(core+relevant+recent injection; everything preserved & searchable; never regress
recall or personality):

**Validated as-is by research:** per-person profile files injected in the system
prompt (the single most validated pattern in the field); keeping ALL raw messages
indexed (verbatim beats extraction everywhere); per-message embedding granularity;
offline maintainer (sleep-time pattern); persona as config never memory.

**The build (in order):**
1. **Embedding model swap**: Xenova/bge-small-en-v1.5 (same 384 dims, 512-token
   window, +10 MTEB-retrieval nDCG over MiniLM). Query-side prefix support in the
   provider; existing model-change reset machinery does the full re-index.
2. **Hybrid search**: FTS5 shadow table over the same rows (headers included),
   dense top-50 + BM25 top-50 → RRF k=60 → existing MMR/exclude pipeline. Plus
   similarity floor + near-dup suppression (>0.9) + provenance labeling.
3. **Chunking**: person/group/archive files section-aware, 800–1600 chars, hard
   cap 2000, breadcrumb header (`{Name} > {Section}`) in embedded+FTS text, never
   split a dated bullet, merge tiny sections; rows person:<file>#<n> WITH the DM
   chatGuid. Artifacts chunked the same way. Message rows gain a
   `[date · chat/speaker]` header line (free — full re-embed happens anyway).
   NOT doing: semantic chunking, late chunking, overlap on structural splits.
4. **Dynamic person files via physical archive** (the operator's design, simplified):
   maintainer gains a deterministic size gate — when a live file exceeds 8KB,
   oldest dated bullets move to persona/people/archive/<handle>.md (append-only,
   nothing deleted) until the live file is ~6KB, keeping the most recent bullets
   per section. Injection code UNCHANGED (live file = core, now bounded); archive
   is chunk-indexed + surfaced per-turn via auto-recall + searchable via tools.
   32/35 files under the gate see zero change.
5. **Episodic summary layer**: new "summary" RowKind; persist catch_me_up recaps
   (with chat scope + date-range headers); compaction summaries if the worker
   exposes them. Included in auto-recall kinds. semantic_search gains `until`,
   artifacts-scope fix, module singletons.
6. **Recall regression probes**: fixed question set answered before/after deploy
   (feeds Phase-5 eval loop).

**Explicitly rejected on evidence:** local reranker (measured harm), HyDE,
knowledge graph, extraction-replaces-history, LLM semantic chunking, late
chunking. Fact-key expansion deferred to Phase 5 (real gains, but costs an LLM
pass per session — belongs with the eval loop that can measure it).
