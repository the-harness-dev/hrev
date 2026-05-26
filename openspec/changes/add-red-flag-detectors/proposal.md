## Why

AI-generated pull requests introduce predictable quality issues — weakened CI safety nets, duplicated code, and logic errors that pass tests but are subtly wrong. These patterns are well-documented and systematic, not one-off mistakes. hrev should ship with built-in detection for them so every review automatically catches these classes of defects without requiring users to write rules from scratch.

## What Changes

- Add a new `Detector` abstraction inside hrev — a structured prompt paired with path scoping and severity — that functions like a built-in rule but is maintained in the codebase rather than user config
- Ship five detectors aligned to the documented AI code review red flags: CI Gaming, Code Reuse Blindness, Hallucinated Correctness, Agentic Ghosting (signals), and Prompt Injection
- Detectors run alongside user-defined rules in the review pipeline with no config required
- Add a `--no-detectors` flag to disable built-in detectors when desired
- Add a `--detectors-only` flag to run only built-in detectors (skip user rules)

## Capabilities

### New Capabilities
- `built-in-detectors`: A system of pre-loaded detection prompts shipped inside hrev that evaluate diffs for common AI-generated code defects, running automatically alongside user-authored rules

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- `src/types.ts`: Add `Detector` interface, update `Config` and `ReviewSummary` types
- `src/graph.ts`: Add detector nodes alongside rule nodes in the LangGraph workflow
- `src/cli.ts`: Add `--no-detectors` and `--detectors-only` flags
- `src/detectors/`: New directory with individual detector files
- `src/config.ts`: Load detectors from built-in module, merge with user rules
