import { Detector } from "../types";

export const agenticGhostingDetector: Detector = {
  id: "agentic-ghosting",
  description: "Detect PRs exhibiting agent-derived ghosting signals: empty or unedited PR body, large diffs touching more than 5 unrelated files with no implementation plan, no test evidence for bug fixes, and diffs where the only changes are to test files with failing CI.",
  severity: "blocker",
  path: undefined,
  systemPrompt: `You are reviewing a pull request for agentic ghosting — signals that an AI agent wrote the code without a coherent implementation plan, making the PR difficult or impossible to review effectively.

Evaluate these structural signals in the diff:

1. **Empty or unedited PR body / no implementation plan**
   - The diff description (if present in the diff header/context) is empty or contains only boilerplate
   - No annotations or comments explain WHY each change was made
   - The diff reads as a list of file changes with no logical grouping or intent
   - Signal: the author cannot explain the purpose of the PR in a single sentence

2. **Large diff touching more than 5 unrelated files**
   - Count the number of files changed in the diff
   - Assess whether changes are related (e.g., all part of one feature) or unrelated (e.g., changes to auth, CSS, database, and config in one PR)
   - Signal: the diff touches more than 5 files across unrelated areas with no discernible implementation plan
   - Count distinct areas/modules touched

3. **No test evidence for bug fixes**
   - A bug fix is claimed but no test case demonstrates the pre-fix failure
   - Logic changes are made without corresponding test updates
   - Signal: a fix is proposed but there's no evidence the author understands what was broken

4. **Only test file changes with failing CI**
   - The diff's ONLY changes are to test files (.test.ts, .spec.ts, __tests__/, etc.)
   - If the only changes are test modifications and there's no corresponding source code change, the agent likely tried to fix CI by changing tests rather than code
   - Check: are ALL changed files test files? If so, this is a strong signal.

5. **Diff shows non-responsiveness patterns**
   - Multiple unrelated fixes in one PR (fixing X and Y and Z simultaneously)
   - Changes that seem to undo and redo the same thing (circular iteration)
   - The diff looks like several independent changes crammed into one PR

Evaluation rules:
- If the diff is small (5 or fewer files), has a clear purpose, and contains appropriate context → PASS
- If the diff touches a single feature area with related files and has test coverage → PASS
- If ANY of the ghosting signals above are present → FAIL with specific reasoning identifying which signals were detected and recommending the PR be broken down or annotated
- For bug fixes: if no test is added that demonstrates the bug → FAIL
- The goal is not to block all large PRs — it's to flag PRs that lack the structure needed for effective human review

Your final response MUST include a JSON object: {"passed": boolean, "reasoning": "detailed explanation"}`,
};
