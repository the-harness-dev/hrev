# Harness Reviewer (`hrev`)

A command-line tool that uses AI models to perform **semantic guard** reviews on git diffs.

**Semantic guards** are plain-English constraints about architectural and behavioral intent. Unlike tests or linters, they evaluate whether a code change respects the *design rationale* of your system.

This document explains the concept and how `hrev` implements it. Whether you use `hrev` or build your own guard pipeline, the same principles apply.

---

## The Problem

AI-assisted coding (Copilot, Cursor, Devin, etc.) expands the solution domain of your codebase. These tools generate code that compiles, passes tests, and looks idiomatic — but can silently violate your architecture because they were never trained on your design intent.

Without explicit constraints, every AI-assisted PR is a drift risk.

**Examples of architectural drift that tests won't catch:**

- A new endpoint bypasses the audit log because the developer (or AI) didn't know it existed.
- A utility function duplicates existing logic because the AI didn't search the codebase.
- A circuit breaker is removed because the diff looked clean but the rationale was lost.
- A feature is built as a web UI first because the AI defaulted to what it sees in training data, not your "MCP tool first" policy.

Tests verify correctness. Linters enforce style and structure. Neither captures *intent*.

---

## Installation

```bash
npm install -g @the-harness-dev/hrev
```

Requires Node ≥ 20.

---

## Configuration

Create `hrev.yml` in your repo root.

```yaml
model: gpt-4o

rules:
  - id: no-direct-aggregate-insert
    description: "Never insert directly into aggregate tables. Always create source documents first and use edge methods."
    severity: blocker
    path: "src/services/"

  - id: mcp-first-design
    description: "New operations must be accessible via MCP server. Design as MCP tool first, web UI second."
    severity: general
    path: "src/"
```

**Model resolution (in order):**
1. `rule.model` — per-rule override
2. `config.model` — project default
3. `HREV_MODEL` — environment variable
4. ❌ Error — no model specified

Works with any OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy), Ollama, Groq, etc.

---

## Environment Variables

```bash
HREV_API_URL=https://api.openai.com/v1
HREV_API_KEY=sk-...
```

---

## What Belongs in `hrev.yml` vs. Your Test Suite / Lint Config

Use AI rules for **intent and behavior** that a unit test cannot easily assert. Do not use AI rules for **deterministic logic** that a unit test or linter covers more reliably, faster, and at zero API cost.

| Use AI Rules (`hrev.yml`) | Use Unit Tests or Lint Instead |
|---|---|
| "Every public API must have a usage example in the docstring" | ✅ Import restrictions (`no-restricted-imports`) |
| "Do not add utility functions that duplicate existing ones" | ✅ Priority logic like model resolution hierarchy |
| "New features need both human-readable reasoning and a pass/fail verdict" | ✅ Aggregator pass/fail logic based on severity levels |
| "Agent nodes must log their prompts, tool calls, and results" | ✅ Path-constraint skip logic (`startsWith` checks) |
| "Error messages must explain *why*, not just *what*" | ✅ API key auto-detection branching (zero/one/multiple keys) |

### Practical guidelines for defining rules

1. **If you can write a unit test for it, do not make it an AI rule.** AI review costs tokens and time. A Jest or `node:test` assertion runs in milliseconds for free. Examples: priority chains, conditional branches, return-code logic.

2. **If a linter enforces it, do not duplicate it in `hrev.yml`.** `hrev` evaluates plain-English descriptions. A custom ESLint rule with an autofix is more precise and requires no model context window. Examples: restricted imports, code style, naming conventions.

3. **If the rule is about *semantic correctness* or *cross-file relationships*, use AI.** These require understanding intent across context a linter cannot see. Examples: architectural patterns, business rules, design rationale.

4. **Keep descriptions short.** Dense prompts bloat context windows and slow reviews. One or two sentences plus a concrete example per rule is ideal. If you find yourself writing a 200-line prompt, split it into multiple focused rules or move the logic into unit tests.

5. **Use severity levels honestly.** Reserve `blocker` for things that must fail CI. Use `general` for patterns that need human attention but should not block merging. Use `nit` for style and readability suggestions.

## Usage

```bash
# Quick setup in any project
hrev init

# Review staged changes
hrev

# Review a specific commit range
hrev --base main --head feature-branch

# Review a specific diff file
hrev --diff path/to/diff.patch

# See per-rule reasoning
hrev --verbose

# Machine-readable JSON output
hrev --json
```

---

## GitHub Actions

Add code review to any existing workflow in **one line**.

### Quick Start

1. Create `hrev.yml` in your repo (semantic rules for your project)
2. Add the action to `.github/workflows/ci.yml`:

```yaml
name: CI
on: [pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required for git diff
      
      - run: npm ci
      - run: npm test
      
      # One-line addition to any workflow
      - uses: the-harness-dev/hrev@v1
        with:
          api-key: ${{ secrets.HREV_API_KEY }}
```

3. Add your API key as a repo secret: `Settings → Secrets → HREV_API_KEY`

### Using GitHub Models (recommended)

If you have GitHub Copilot, you already have access to [GitHub Models](https://docs.github.com/en/rest/models):

```yaml
- uses: the-harness-dev/hrev@v1
  with:
    api-url: https://models.github.ai
    api-key: ${{ secrets.HREV_API_KEY }}
    model: openai/gpt-4.1
```

Create a fine-grained personal access token with the `models:read` scope at [github.com/settings/tokens](https://github.com/settings/tokens).

### With Custom Config

```yaml
- uses: the-harness-dev/hrev@v1
  with:
    api-key: ${{ secrets.HREV_API_KEY }}
    config-file: .github/hrev.yml
    verbose: true
```

### Auto-Detect API Key (no api-key input needed)

If exactly one of these env vars is set, hrev will use it automatically:

```yaml
# Zero-config if you already have OPENAI_API_KEY
- uses: the-harness-dev/hrev@v1
```

Supported auto-detected variables: `HREV_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`

### All Options

| Input | Default | Description |
|---|---|---|
| `api-url` | `https://models.github.ai` | Model API endpoint |
| `api-key` | auto-detected | API key (GitHub Secret) |
| `model` | `openai/gpt-4.1` | Model identifier |
| `config-file` | `hrev.yml` | Path to rules config |
| `base-ref` | PR base SHA | Git ref for diff comparison |
| `verbose` | `false` | Show per-rule details in logs |
| `comment` | `true` | Post review summary as PR comment |
| `status` | `true` | Set commit status check (pass/fail) |

---

## The Three-Layer Constraint Stack

A codebase is protected by three layers of guards. `hrev` is the third. You need all three.

### Layer 1: Deterministic Guards

Unit tests, type checkers, linters, and static analysis. They verify what happens in a controlled, repeatable way.

- **Precision:** Exact — a test either passes or fails.
- **Scope:** One function, one module, one assertion.
- **Cost:** Near-zero (CPU time).
- **Limitation:** Cannot assert intent, design rationale, or cross-file architectural patterns.

**Always use these first.** Before you define a semantic guard, ask: "Can a unit test assert this?" If yes, write the test. If no, proceed.

**Examples of deterministic guards:**
- Import restrictions (`no-restricted-imports` in ESLint)
- Return types and type safety (TypeScript, mypy)
- Priority chains (unit test the function, not the intent)
- Branch coverage and conditional logic
- Path-constraint matching (`startsWith` checks)

### Layer 2: Structural Guards

Module boundaries, package rules, dependency injection, and directory conventions. They enforce what can depend on what, and where code can live.

- **Precision:** Exact — a module either imports from the right layer or it doesn't.
- **Scope:** One edge in the dependency graph.
- **Cost:** Near-zero (build time).
- **Limitation:** Cannot assert *why* a dependency exists, only *that* it does.

**Examples of structural guards:**
- Package-level import restrictions (e.g., `src/domain/` cannot import from `src/ui/`)
- Cyclic dependency detection
- Directory-based conventions (feature folders, Clean Architecture layers)
- API contract validation (OpenAPI, Protocol Buffers)

### Layer 3: Semantic Guards

Plain-English rules that constrain *intent*. They evaluate whether a code change respects the design rationale that exists in the heads of your senior engineers but in no compiler, linter, or type system.

- **Precision:** Probabilistic — an LLM reads the diff and the rule, then reasons about alignment.
- **Scope:** Cross-file, cross-module, whole-system.
- **Cost:** Token cost and latency (expensive).
- **Strength:** Can assert things no other layer can.

**When and only when to use semantic guards:**
- The rule is about architectural or behavioral *intent*.
- The rule spans multiple files and requires contextual reasoning.
- No unit test or linter can practically assert it.
- A human code reviewer would need to be present to catch it.

**Examples of semantic guards:**
- "Every public API must have a usage example in the docstring."
- "Debits must equal credits before persisting a financial transaction."
- "New features must be accessible via MCP server before they get a web UI."
- "Do not silently ignore exceptions — every catch block must log, transform, or rethrow."
- "Adding a new utility function? Search the codebase first for an equivalent."

---

## Where Semantic Guards Do *Not* Fit

Do not use semantic guards for what deterministic guards do better, faster, and at zero token cost.

| Use Deterministic or Structural | Do Not Use Semantic Guards For |
|---|---|
| Import restrictions | "Only use LangChain providers" (use `no-restricted-imports`) |
| Return-code logic | "Fail the review if any blocker fails" (unit-test the aggregator) |
| Priority chains | "Resolve model in order: rule > project > env" (unit-test `resolveModel`) |
| Path matching | "Skip rules when diff doesn't touch the path" (unit-test `startsWith` logic) |
| Branching logic | "Auto-detect exactly one API key" (unit-test the conditional branches) |
| API contract shape | "All integrations must be OpenAI-compatible" (type-check the interface) |

**Rule of thumb:** If you can write a unit test or linter rule for it, doing so is more precise, faster, and eliminates LLM hallucination risk.

---

## How to Write Semantic Constraints

Whether you use `hrev`, a custom pipeline, or manual review, follow these guidelines.

### 1. One Rule, One Intent

Don't pack multiple concerns into a single description. Each rule should constrain exactly one behavior.

**Bad:** "New code should be well-tested, follow our design patterns, and include docstrings."

**Good:**
- "New features must include a test demonstrating the pre-fix failure."
- "Every new endpoint must create a source document before persisting to an aggregate table."

### 2. Severity Is a Contract

- **`blocker`:** CI fails. The merge is blocked. Use only for architectural or security invariants.
- **`general`:** Visible to human reviewers, but doesn't block the merge. Use for patterns that need attention.
- **`nit`:** Optional. Use for style and readability suggestions.

**Bad:** Every rule is `blocker`.

**Good:** A rule is `blocker` because violating it *breaks a system invariant*. Not because it's important, but because it's *load-bearing*.

### 3. Scope with Path Constraints

Only run a rule against diffs that touch the files it cares about. A rule about GitHub Actions shouldn't evaluate a change to your domain models.

**Example:**

```yaml
- id: prompt-injection-safety
  description: "Workflows passing untrusted user input to LLM prompts must sanitize or quote the input."
  severity: blocker
  path: .github/workflows/
```

### 4. Keep Descriptions Short

Dense prompts bloat context windows and slow reviews. One or two sentences plus a concrete example per rule is ideal. If you find yourself writing a 200-line specification, split it into multiple focused rules or move the logic into unit tests.

**Good:**

```yaml
- id: circuit-breaker-required
  description: |
    Outbound HTTP calls must use a circuit breaker. Do not add naive
    `fetch()` or `axios.get()` without timeout, retry-with-backoff, or
    a circuit breaker abstraction.
  severity: blocker
  path: src/services/
```

**Bad:** A 20-point checklist covering every edge case of circuit breaker behavior. That's a library implementation spec, not a guard intent.

### 5. Examples Beat Explanations

A single concrete example of a violation is more useful than an abstract definition.

**Good:**

```yaml
- id: no-direct-aggregate-insert
  description: |
    Never insert directly into aggregate tables. Create source
    documents first and use edge methods.

    BAD:  db.insertInto("order_totals").values(data)
    GOOD: order.createSourceDocument(data)
```

---

## How It Runs

Rules are evaluated in parallel via LangGraph. Each node gets:
- The full git diff
- One rule (plain English description + severity)
- Optional path constraint (skips if diff doesn't touch that path)

Results feed into an aggregator that:
- Fails the review if any `blocker` rule fails
- Reports `general` and `nit` violations for human review
- Summarizes with per-rule reasoning

---

## FAQ

### Why plain English instead of a formal specification language?

Formal specs are precise but brittle. They require learning a DSL and maintenance as the spec language itself evolves. Plain English is understood by every engineer and AI model today. The tradeoff is probabilistic precision — which is acceptable for the cross-file, intent-driven problems semantic guards solve.

### When should I add a rule vs. write a unit test?

If the behavior is deterministic and testable in a single module, write a unit test. If the behavior requires reasoning across files, understanding design rationale, or evaluating tradeoffs that aren't encoded in code, use a semantic guard.

### What if my team doesn't use `hrev`?

The concepts in this document apply regardless of tooling. You can implement the same idea with:
- A custom CI step that sends the diff and rules to OpenAI, Anthropic, or any other LLM API
- A manual code review checklist that reviewers follow for every PR
- A combination of the above, with the checklist automated where possible

The output format (pass/fail + reasoning) is what matters, not the specific implementation.

### How many rules should I have?

Start with 3–5 high-value guards. More rules mean longer reviews and higher token costs. Remove or downgrade rules that produce false positives. A few sharp guards beat a hundred vague ones.

### Should built-in detector rules run alongside my custom rules?

Yes. Built-in detectors catch classes of AI-generated risks (prompt injection, CI gaming, hallucinated correctness) that are easy to miss in custom rule sets. They require no configuration and run automatically.

---

## License

MIT
