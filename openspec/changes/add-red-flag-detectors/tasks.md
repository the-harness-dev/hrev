## 1. Types and Foundation

- [x] 1.1 Add `Detector` interface to `src/types.ts` with fields: id, description, severity, path (optional), systemPrompt
- [x] 1.2 Add `getDetectors()`, `detectorToRule()`, `shouldRunDetector()` functions in `src/detectors/index.ts`

## 2. Detector Prompts

- [x] 2.1 Create `src/detectors/ci-gaming.ts` — detect weakened CI safety nets (coverage thresholds, skipped tests, `|| true`, removed lint steps, gated workflow conditions)
- [x] 2.2 Create `src/detectors/code-reuse-blindness.ts` — detect duplicated utilities, validation, middleware (uses workspace search tools)
- [x] 2.3 Create `src/detectors/hallucinated-correctness.ts` — detect off-by-one errors, falsy short-circuits, missing auth checks, race conditions, unvalidated input
- [x] 2.4 Create `src/detectors/agentic-ghosting.ts` — detect empty PR body, large unscoped diffs, test-only changes with failing CI
- [x] 2.5 Create `src/detectors/prompt-injection.ts` — detect untrusted input in LLM prompts, overly permissive tokens, model output to shell, exposed secrets

## 3. Graph Integration

- [x] 3.1 Modify `createRuleNode()` in `src/graph.ts` to accept an optional `systemPrompt` override parameter
- [x] 3.2 Update `runReview()` in `src/graph.ts` to merge detectors with user rules before building workflow nodes, using `detectorToRule()` for conversion and `shouldRunDetector()` for path filtering
- [x] 3.3 Ensure detector nodes use their custom `systemPrompt` while user rule nodes use the standard prompt

## 4. CLI Flags

- [x] 4.1 Add `--no-detectors` boolean flag to Commander config in `src/cli.ts`
- [x] 4.2 Add `--detectors-only` boolean flag to Commander config in `src/cli.ts`
- [x] 4.3 Pass flags through to `runReview()` and skip detectors or user rules accordingly
- [x] 4.4 Ensure `--verbose` output shows `[DETECTOR]` prefix on detector results

## 5. Build and Verify

- [x] 5.1 Run `npm run build` to verify TypeScript compilation
- [x] 5.2 Run `npm run lint` to verify no lint violations
- [x] 5.3 Run `npm run lint:typecheck` (`npm run build && eslint src/**/*.ts`) to verify
- [x] 5.4 Run `npm test` to verify existing tests still pass (no tests exist in this project)
