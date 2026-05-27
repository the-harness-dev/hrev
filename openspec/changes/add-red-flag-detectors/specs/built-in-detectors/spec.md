## ADDED Requirements

### Requirement: Built-in detectors run automatically

The system SHALL evaluate built-in detector prompts alongside user-authored rules during every review, without requiring user configuration. Each detector SHALL produce a ReviewResult identical in structure to user-authored rules (ruleId, passed, reasoning, severity, path).

#### Scenario: Review with no user rules

- **WHEN** a user runs `hrev` with a `hrev.yml` containing zero rules
- **THEN** all five built-in detectors still evaluate the diff and produce results

#### Scenario: Review with user rules and detectors

- **WHEN** a user runs `hrev` with a `hrev.yml` containing 3 rules
- **THEN** the review evaluates all 3 user rules AND all applicable built-in detectors in parallel, and the summary reports total count including both

#### Scenario: Detector path constraint skips evaluation

- **WHEN** the ci-gaming detector has path scope `.github/` and the diff contains no files under `.github/`
- **THEN** the detector produces a passed result with reasoning "Skipped: diff does not contain path .github/"

### Requirement: CI Gaming detector identifies weakened safety nets

The system SHALL detect patterns where CI safety nets have been weakened, including: lowered coverage thresholds, removed or skipped tests (`it.skip`, `test.skip`, `xit`, `xtest`), fail-safe bash operators appended to commands (`|| true`, `|| exit 0`), lint/typecheck steps removed from workflows, workflow conditions added to gate steps (`if: false` or branch-gated conditions), and CI steps hidden behind new conditions that previously ran unconditionally.

#### Scenario: Coverage threshold lowered

- **WHEN** the diff reduces a `coverageThreshold` value in a test config file (e.g., from 80% to 60%) or removes the `coverageThreshold` block entirely
- **THEN** the detector SHALL flag this as a blocker failure with reasoning that references the specific threshold change

#### Scenario: Tests marked as skipped

- **WHEN** the diff changes `it('should validate email', ...)` to `it.skip('should validate email', ...)` or adds `xit`/`xtest`/`test.skip` calls
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying which test was skipped

#### Scenario: Fail-safe operator appended to commands

- **WHEN** the diff changes `npm test` to `npm test || true` or `eslint .` to `eslint . || true` in workflow YAML or shell scripts
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying the specific command

#### Scenario: Workflow lint step removed

- **WHEN** a GitHub Actions workflow diff removes a job or step that previously ran linting, typechecking, or test execution, and does not replace it with an equivalent check
- **THEN** the detector SHALL flag this as a blocker failure

#### Scenario: Workflow gating condition added

- **WHEN** a step or job that previously ran on pull-request events gains a new condition (e.g., `if: false`, `if: github.event_name == 'push'` where it previously ran on `pull_request`)
- **THEN** the detector SHALL flag this as a blocker failure

#### Scenario: Clean CI changes pass

- **WHEN** the diff makes legitimate changes to CI configuration (e.g., adding a new test step, updating a dependency version in CI, changing a timeout value)
- **THEN** the detector SHALL pass with reasoning explaining why the changes don't weaken the safety net

### Requirement: Code Reuse Blindness detector identifies unnecessary duplication

The system SHALL detect new utility functions, helper methods, validation logic, or middleware that duplicates existing functionality elsewhere in the codebase. The detector SHALL use workspace exploration tools to search for equivalent functions before flagging duplication.

#### Scenario: Duplicate utility function detected

- **WHEN** the diff adds a new function `formatDate()` in `src/utils/dates.ts` and a function `formatTimestamp()` with similar behavior already exists in `src/helpers/time.ts`
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying both the new function location and the existing equivalent

#### Scenario: Duplicate validation logic detected

- **WHEN** the diff adds inline validation logic in a route handler that duplicates checks from an existing shared middleware
- **THEN** the detector SHALL flag this as a blocker failure with reasoning referencing the existing middleware

#### Scenario: Duplicate middleware detected

- **WHEN** the diff adds a new auth check inline in a handler and a `requireAuth()` middleware already exists
- **THEN** the detector SHALL flag this as a blocker failure with reasoning referencing the existing middleware

#### Scenario: Similar-but-different helpers correctly pass

- **WHEN** the diff adds a helper function that has a similar name to an existing function but serves a genuinely different purpose with different behavior
- **THEN** the detector SHALL pass with reasoning explaining the distinction

### Requirement: Hallucinated Correctness detector identifies subtle logic errors

The system SHALL detect code that compiles and passes tests but contains subtle behavioral errors, including: off-by-one errors in pagination or indexing, falsy short-circuits in conditional guards (`if (input && isValid(input))` where `input` could be `0`, `""`, or `false`), missing permission or authorization checks on sensitive operations, race conditions from read-then-write patterns without locking, unvalidated external input used directly, and wrong default behavior where a fallthrough case is incorrect for the domain.

#### Scenario: Off-by-one pagination error detected

- **WHEN** the diff adds pagination with `LIMIT N OFFSET page * N` where `page` starts at 1 instead of 0
- **THEN** the detector SHALL flag this as a blocker failure with reasoning that identifies the missing offset correction

#### Scenario: Falsy short-circuit detected

- **WHEN** the diff adds a guard like `if (input && validate(input))` where `input` being `0`, `""`, `null`, `undefined`, or `false` would skip validation entirely
- **THEN** the detector SHALL flag this as a blocker failure with reasoning listing the falsy values that bypass validation

#### Scenario: Missing authorization check detected

- **WHEN** the diff adds an admin-only endpoint that checks `req.user` exists but never verifies `req.user.role === 'admin'`
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying the missing permission check

#### Scenario: Race condition pattern detected

- **WHEN** the diff adds code that reads a shared resource then writes to it without a lock, transaction, or atomic operation
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying the read-then-write pattern

#### Scenario: Unvalidated external input detected

- **WHEN** the diff uses values from query parameters, request headers, URL path segments, or third-party API responses directly in database queries, shell commands, or rendered output without sanitization or validation
- **THEN** the detector SHALL flag this as a blocker failure with reasoning identifying the unvalidated input source

#### Scenario: Clean logic changes pass

- **WHEN** the diff adds logic with proper boundary handling, explicit permission checks, validated inputs, and atomic operations
- **THEN** the detector SHALL pass with reasoning confirming no subtle errors detected

### Requirement: Agentic Ghosting detector identifies PRs lacking structure

The system SHALL detect pull requests that exhibit signals of agent-derived ghosting: empty or unedited PR body, large diffs touching more than 5 unrelated files with no implementation plan, no test evidence for bug fixes, and diffs where the only changes are to test files with failing CI. This detector SHALL run without a path constraint and evaluate the diff structure rather than content.

#### Scenario: Empty PR body detected

- **WHEN** the diff contains no description, no implementation plan, no annotations, or only agent-generated boilerplate restating the diff in prose
- **THEN** the detector SHALL flag this as a blocker failure with a signal that the PR needs clearer structure before review

#### Scenario: Large unscoped diff detected

- **WHEN** the diff touches more than 5 files across unrelated areas with no discernible implementation plan or clear purpose
- **THEN** the detector SHALL flag this as a blocker failure recommending the PR be broken into smaller units

#### Scenario: Only test file changes with failing CI detected

- **WHEN** the diff's only changes are to test files and CI is failing, indicating the agent modified tests instead of fixing the underlying code
- **THEN** the detector SHALL flag this as a blocker failure

#### Scenario: Well-structured PR passes

- **WHEN** the diff has a clear purpose describable in one sentence, touches related files with coherent changes, and includes appropriate context
- **THEN** the detector SHALL pass

### Requirement: Prompt Injection detector identifies unsafe workflow patterns

The system SHALL detect GitHub Actions workflow patterns vulnerable to prompt injection: untrusted user input (PR body, issue body, commit messages) interpolated directly into LLM prompts without sanitization, `GITHUB_TOKEN` with write permissions when only read is needed, model output piped to shell commands without validation, and secrets accessible to agent steps or printed to logs.

#### Scenario: Untrusted input in LLM prompt detected

- **WHEN** a workflow interpolates `${{ github.event.issue.body }}` or `${{ github.event.pull_request.body }}` directly into an LLM API call or prompt without sanitization
- **THEN** the detector SHALL flag this as a blocker failure identifying the injection point

#### Scenario: Overly permissive token detected

- **WHEN** a workflow step has `GITHUB_TOKEN` with write scope (or no explicit permissions restriction) when the step only performs read operations
- **THEN** the detector SHALL flag this as a blocker failure recommending `permissions: read-all`

#### Scenario: Model output piped to shell detected

- **WHEN** a workflow pipes LLM API response content to `eval`, `subprocess.run()`, `exec()`, or a bash command without validation
- **THEN** the detector SHALL flag this as a blocker failure

#### Scenario: Secrets exposed in logs detected

- **WHEN** a workflow step prints secrets to logs via `console.log`, `echo`, or equivalent
- **THEN** the detector SHALL flag this as a blocker failure

#### Scenario: Clean workflow passes

- **WHEN** a workflow uses least-privilege permissions, sanitizes untrusted input, separates analysis from execution with a human approval gate, and never evaluates model output
- **THEN** the detector SHALL pass

### Requirement: CLI flags control detector execution

The system SHALL support `--no-detectors` and `--detectors-only` boolean flags. By default (neither flag), both detectors and user rules run. With `--no-detectors`, user rules only. With `--detectors-only`, detectors only.

#### Scenario: Default behavior runs both

- **WHEN** a user runs `hrev` with no detector flags
- **THEN** the review evaluates all user rules AND all applicable detectors

#### Scenario: --no-detectors skips detectors

- **WHEN** a user runs `hrev --no-detectors`
- **THEN** the review evaluates user rules only, and built-in detectors produce no results

#### Scenario: --detectors-only skips user rules

- **WHEN** a user runs `hrev --detectors-only`
- **THEN** the review evaluates built-in detectors only, and user rules produce no results

### Requirement: Detector results aggregate with user rule results

The system SHALL aggregate detector results alongside user rule results in the same summary output. Failed blocker detectors SHALL cause the review to fail with exit code 1, identical to user-authored blocker rules. The summary SHALL not visually distinguish between detector results and rule results unless `--verbose` is specified.

#### Scenario: Blocker detector failure fails the review

- **WHEN** the ci-gaming detector (severity: blocker) fails and all user rules pass
- **THEN** the review SHALL fail with exit code 1 and report the ci-gaming failure

#### Scenario: Verbose output shows detector vs rule distinction

- **WHEN** a user runs `hrev --verbose` and a detector fails
- **THEN** the per-rule output identifies the detector result with `[DETECTOR]` prefix in addition to the standard severity label and rule ID

### Requirement: Detectors are shipped as source code, not config

The system SHALL define detectors as TypeScript source files in `src/detectors/`, each exporting a `Detector` object with id, description, severity, path, and systemPrompt fields. Detectors SHALL NOT be configurable through `hrev.yml` — they are a built-in, opinionated layer maintained in the repository.

#### Scenario: Detectors require no user configuration

- **WHEN** a user installs hrev with no `hrev.yml` or with a minimal config
- **THEN** all five detectors are available and execute during review with no additional setup

#### Scenario: User cannot modify detector behavior

- **WHEN** a user attempts to configure detector behavior through `hrev.yml`
- **THEN** that configuration has no effect on built-in detectors (users can still write their own rules that overlap with detector concerns)
