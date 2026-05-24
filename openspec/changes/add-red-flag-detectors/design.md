## Context

hrev currently evaluates user-authored rules against git diffs. Each rule is a plain-English description run through an LLM. Users configure rules in `hrev.yml`.

The `ai-agent-pr-red-flags.md` document identifies five systematic defect patterns in AI-generated code. These patterns are well-defined and detectable through code analysis. Rather than asking every hrev user to write their own rules for these patterns, hrev should ship with built-in detection prompts.

## Goals / Non-Goals

**Goals:**
- Ship five built-in detectors covering the documented red flags: CI Gaming, Code Reuse Blindness, Hallucinated Correctness, Agentic Ghosting (signals), and Prompt Injection
- Detectors run automatically alongside user rules with no configuration required
- Detectors use the same LangGraph pipeline as user rules for parallelism and aggregation
- Users can disable detectors (`--no-detectors`) or run only detectors (`--detectors-only`)
- Each detector has a predefined severity (all five are `blocker`) and path scope

**Non-Goals:**
- Adding a confidence score or `requiresHumanReview` field to verdicts (that's a separate change)
- Changing the user-facing rule/ReviewResult/ReviewSummary types (detectors produce the same shape)
- Replacing the text-based TOOL: regex parser (that's a separate hardening change)
- Live updates or remote configuration for detectors (they're static, shipped in the package)

## Decisions

### Decision 1: Detector as a first-class type vs. overloading Rule

**Chosen: New `Detector` type, mapped to `Rule` at the graph boundary.**

A `Detector` has the same fields as a `Rule` (id, description, severity, path) plus a `systemPrompt` field — the structured prompt that guides the LLM's reasoning. At the graph level, a `Detector` is converted into a `Rule`-shaped object and fed into the same evaluation nodes. This keeps the graph and aggregation code unchanged while allowing detectors to carry richer prompting.

```
┌──────────────────────────────────────────────────────────┐
│  Detector              →  toRule()  →  Rule              │
│  ├─ id: "ci-gaming"       │         ├─ id: "ci-gaming"   │
│  ├─ description: "..."    │         ├─ description: "..." │
│  ├─ severity: blocker     │         ├─ severity: blocker  │
│  ├─ path: ".github/"      │         ├─ path: ".github/"   │
│  └─ systemPrompt: "...."  │                              │
│     (used in graph,        │                              │
│      not on Rule)          │                              │
└──────────────────────────────────────────────────────────┘
```

**Alternative considered**: Overloading `Rule` with an optional `systemPrompt` field. Rejected because it muddies the user-facing config schema. Detectors and rules are conceptually different: rules are user-authored descriptions, detectors are carefully engineered prompts.

### Decision 2: Detector severity

**Chosen: All five detectors default to `blocker` severity.**

Each red flag in the source document is described as a blocker ("Any 'yes' is a blocker"). They default to `blocker` to match this guidance. Users who want lower severity can still write their own rules in `hrev.yml`.

### Decision 3: Detector path scoping

Each detector has a predefined path constraint to avoid evaluating irrelevant diffs:

| Detector | Path | Rationale |
|---|---|---|
| `ci-gaming` | `.github/`, `*.config.*`, `jest.config.*`, `vitest.config.*`, `eslint.*` | CI and test config files |
| `code-reuse-blindness` | `src/` | Source code only |
| `hallucinated-correctness` | `src/` | Logic errors in source |
| `agentic-ghosting` | N/A (no path — always runs) | Evaluates PR structure itself |
| `prompt-injection` | `.github/workflows/` | Workflow YAML files |

### Decision 4: Where detectors live in the codebase

**Chosen: `src/detectors/` directory with individual `.ts` files exporting `Detector` objects.**

```
src/detectors/
  index.ts              ← aggregates and exports all detectors
  ci-gaming.ts
  code-reuse-blindness.ts
  hallucinated-correctness.ts
  agentic-ghosting.ts
  prompt-injection.ts
```

The `index.ts` exports a `getDetectors(): Detector[]` function. `graph.ts` imports this and merges them with user rules before building the workflow.

### Decision 5: CLI flags

**Chosen: `--no-detectors` and `--detectors-only` as boolean flags.**

- `--no-detectors`: Skip built-in detectors, only run user rules (current behavior)
- `--detectors-only`: Only run built-in detectors, skip user rules (useful for quick AI-code quality scans)
- Default (neither flag): Run both

The action.yml does not need to change because detectors run by default with no new config requirements.

### Decision 6: detector-specific systemPrompt design

Each detector gets a custom system prompt that goes beyond the standard rule evaluation prompt. The standard prompt (`graph.ts:140-167`) asks "does this diff violate the rule?" The detector prompts include:
- A preamble explaining what to look for with specific examples from the red flags document
- A structured checklist to walk through
- A directive to search the workspace when relevant (for code-reuse-blindness)

The detector's `systemPrompt` REPLACES the standard system prompt for that evaluation node, while the userPrompt (the diff) stays the same.

## Risks / Trade-offs

**[R1] More LLM calls per review** → Each detector is evaluated as a parallel node, same as a user rule. With five detectors, this adds up to 5 extra LLM calls per review. Mitigation: detectors only run when the diff touches their path scope, so most reviews won't trigger all five.

**[R2] detector false positives** → Structured prompts can still produce false positive flagging, especially for hallucinated-correctness where the distinction between "valid code" and "wrong code" is subjective. Mitigation: detectors produce the same `reasoning` field as rules, so users can read the reasoning and judge. We may want to add a `confidence` field in a future change.

**[R3] detector prompts encode bias** → The prompts themselves are opinionated (e.g., "never use `|| true`"). A creative developer might have a legitimate use case. Mitigation: `--no-detectors` lets users opt out entirely.

**[R4] agentic-ghosting detector is meta** → This detector evaluates PR structure (empty body, no plan, file count) rather than code content. It's the least code-focused detector and may not fit naturally in the diff-based evaluation model. Mitigation: it runs without a path constraint and uses the diff's metadata (file list) rather than content analysis alone.

## Open Questions

<!-- None at this stage — the design above resolves all known ambiguities. -->
