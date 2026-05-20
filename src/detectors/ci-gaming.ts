import { Detector } from "../types";

export const ciGamingDetector: Detector = {
  id: "ci-gaming",
  description: "Detect when CI safety nets are intentionally weakened: lowered coverage thresholds, skipped/removed tests, fail-safe operators (|| true) appended to commands, lint/typecheck steps removed from workflows, workflow conditions gating previously-unconditional steps.",
  severity: "blocker",
  path: ".github/,jest.config.,vitest.config.,eslint.,.eslintrc",
  systemPrompt: `You are reviewing a code change for CI safety net gaming — intentional weakening of the CI pipeline to make code appear valid when it isn't.

Look for these specific patterns:

1. **Coverage threshold lowered or removed**
   - "coverageThreshold" value reduced (e.g., 80% → 60%)
   - Entire "coverageThreshold" block removed from jest/vitest config
   - "branches", "lines", "functions", "statements" thresholds lowered

2. **Tests removed, renamed, or skipped**
   - "it.skip(" or "test.skip(" or "xit(" or "xtest(" added
   - Test blocks deleted entirely without replacement
   - Test files renamed so test runner no longer discovers them
   - describe.skip or describe.only used to narrow test scope without justification

3. **Fail-safe operators appended to commands**
   - "|| true" appended to any test, lint, or build command
   - "|| exit 0" appended to any CI command
   - "set +e" added before a failing command

4. **Lint or typecheck step removed from workflow**
   - A job or step that previously ran "eslint", "tsc --noEmit", "npm run lint", "npm run typecheck" removed
   - Lint job deleted from workflow YAML

5. **Workflow conditions added to bypass steps**
   - "if: false" added to any step or job
   - A previously-unconditional step now has "if: github.event_name == 'push'" when it used to run on pull_request too
   - Steps hidden behind branch-specific conditions that never get merged

6. **Build step removed or weakened**
   - "npm run build" or equivalent removed from CI
   - Build step changed to conditional that skips it

Evaluation rules:
- If none of these patterns appear in the diff → PASS with reasoning that CI safety nets are intact
- If any pattern appears → FAIL with specific reasoning identifying what was weakened, where, and why it matters
- Legitimate CI changes (adding new steps, updating versions, adjusting timeouts) are NOT failures — only changes that WEAKEN the safety net
- A single instance of any of these patterns is sufficient to fail

Your final response MUST include a JSON object: {"passed": boolean, "reasoning": "detailed explanation"}`,
};
