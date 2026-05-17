# Harness Reviewer (`hrev`)

A command-line tool that uses AI models to perform rules-based code reviews on git diffs. Part of the harness.dev ecosystem.

## What Makes This Different

`hrev` evaluates **semantic rules** — things a linter or static analyzer *cannot* catch:

- Architectural compliance ("always use source documents before aggregates")
- Cross-cutting concerns ("every financial transaction must balance")
- Business logic integrity ("don't silently ignore errors")
- Design patterns ("new features must be MCP tools first, UI second")

Each rule is written in plain English. An AI model reads the diff and the rule, then reasons about whether the code violates the intent.

## How It Works

1. Define review rules in a `hrev.yml` config file in your repo
2. Each rule is evaluated in parallel by a LangGraph node
3. An aggregator node determines pass/fail based on severity
4. Returns exit code 1 if any blocker fails

## Rule Severity Levels

- `nit` — Minor suggestions, non-blocking
- `general` — Standard recommendations
- `blocker` — Must fix, fails the review

## Installation

```bash
npm install -g harness-reviewer
```

## Configuration

Create `hrev.yml` in your repo root. You **must** specify a model — there is no default.

```yaml
# Project-level model (required unless every rule specifies its own)
# Use any model name your provider supports: gpt-4o, claude-3-5-sonnet, llama3.1, etc.
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
    # Override project model for this rule
    model: gpt-4o-mini
```

**Model resolution (in order):**
1. `rule.model` — per-rule override
2. `config.model` — project default
3. `HREV_MODEL` — environment variable
4. ❌ Error — no model specified

Works with any OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy), Ollama, Groq, etc.

## Environment Variables

```bash
HREV_API_URL=https://api.openai.com/v1
HREV_API_KEY=sk-...
```

Supports any OpenAI-compatible endpoint (OpenAI, local Ollama, etc).

## Why Not a Linter?

| What you want | Can a linter do it? | Can `hrev` do it? |
|---|---|---|
| "No trailing whitespace" | ✅ Yes | Overkill |
| "Functions under 50 lines" | ✅ Yes | Overkill |
| "Always create source documents before aggregate inserts" | ❌ No | ✅ Yes |
| "Debits must equal credits before persisting" | ❌ No | ✅ Yes |
| "MCP tool first, UI second" | ❌ No | ✅ Yes |
| "Don't silently ignore exceptions" | ❌ No | ✅ Yes |

## Usage

```bash
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

## GitHub Actions

Add code review to any existing workflow in **one line**. No contributor setup needed — the maintainer manages the API key.

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

## How It Runs

Rules are evaluated in parallel via LangGraph. Each node gets:
- The full git diff
- One rule (plain English description + severity)
- Optional path constraint (skips if diff doesn't touch that path)

Results feed into an aggregator that:
- Fails the review if any `blocker` rule fails
- Reports `general` and `nit` violations for human review
- Summarizes with per-rule reasoning

## License

MIT
