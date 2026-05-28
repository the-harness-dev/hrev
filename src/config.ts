import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { Config, Rule } from "./types";
import { z } from "zod";

const severitySchema = z.enum(["nit", "general", "blocker"]);

const ruleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  severity: severitySchema,
  path: z.string().optional(),
  model: z.string().optional(),
});

const configSchema = z.object({
  model: z.string().optional(),
  rules: z.array(ruleSchema).min(1),
});

// --- Built-in detector rules ---

const BUILTIN_PROMPT_INJECTION: Rule = {
  id: "prompt-injection",
  description: `You are reviewing a GitHub Actions workflow for prompt injection vulnerabilities — patterns where untrusted input can reach an LLM prompt or where the workflow has excessive permissions.

Look for these specific patterns:

1. **Untrusted user input interpolated into LLM prompts**
   - "\${{ github.event.issue.body }}" passed directly to an LLM API call
   - "\${{ github.event.pull_request.body }}" interpolated into a prompt
   - "\${{ github.event.comment.body }}" used in model input
   - "\${{ github.event.head_commit.message }}" or any commit message in a prompt
   - "\${{ github.event.pull_request.title }}" in a prompt
   - Any github.event.*.body or similar free-text user input reaching an LLM call without sanitization or quoting

2. **GITHUB_TOKEN with write permissions when only read is needed**
   - "contents: write" or "pull-requests: write" when the step only reads
   - No explicit "permissions:" block — default permissions may be overly broad
   - Token used with "write" scope for operations that only need "read"
   - Check: does the workflow step actually need write access, or could it work with read-only?

3. **Model output piped to shell commands without validation**
   - LLM API response passed to "eval()", "subprocess.run()", or "exec()"
   - Model output used in a bash command via "$()" or backticks
   - "curl ... | bash" or "pip install" based on model output
   - Any pattern where LLM output is treated as executable without a human approval gate
   - Check: is there a step that takes the model's response and runs it as a command?

4. **Secrets accessible to agent steps or printed to logs**
   - "secrets.LIVE_API_KEY" or similar exposed to a step that calls an LLM
   - "console.log" or "echo $SECRET" printing secrets to logs
   - API keys, tokens, or passwords in environment variables for agent steps
   - Check: does any step print or log values from the "secrets" or "env" context?

5. **Missing human approval gate for production actions**
   - Workflow automatically deploys or modifies production based on model output
   - No "environment:" protection on deployment steps
   - Analysis and execution happen in the same step without human review
   - Check: is there a manual approval step between analysis and execution?

Evaluation rules:
- If none of these patterns appear → PASS with reasoning that the workflow follows security best practices
- If any pattern appears → FAIL with specific reasoning identifying the vulnerability, the line/location, and the recommended fix
- Apply the principle of least privilege: if the token has more scope than needed, flag it
- The key threat vector is: untrusted input → LLM prompt → model output → shell execution → with write-scoped token

Your final response MUST include a JSON object: {"passed": boolean, "reasoning": "detailed explanation"}`,
  severity: "blocker",
  path: ".github/workflows/",
};

const BUILTIN_AGENTIC_GHOSTING: Rule = {
  id: "agentic-ghosting",
  description: `You are reviewing a pull request for agentic ghosting — signals that an AI agent wrote the code without a coherent implementation plan, making the PR difficult or impossible to review effectively.

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
  severity: "blocker",
};

const BUILTIN_CI_GAMING: Rule = {
  id: "ci-gaming",
  description: `You are reviewing a code change for CI safety net gaming — intentional weakening of the CI pipeline to make code appear valid when it isn't.

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
  severity: "blocker",
  path: ".github/,jest.config.,vitest.config.,eslint.,.eslintrc",
};

const BUILTIN_HALLUCINATED_CORRECTNESS: Rule = {
  id: "hallucinated-correctness",
  description: `You are reviewing a code change for hallucinated correctness — code that looks right structurally but contains subtle behavioral errors.

Look for these specific patterns:

1. **Off-by-one errors in pagination, indexing, or iteration**
   - "LIMIT N OFFSET page * N" where "page" starts at 1 (should be (page-1) * N)
   - Array or list indexing that starts at 1 when the language uses 0-based indexing
   - Loop bounds: "i <= length" when it should be "i < length"
   - Slice operations: incorrect end index, off-by-one boundaries
   - Check: trace through with page=1, page=0, empty collection, single item

2. **Falsy short-circuits in conditional guards**
   - "if (input && validate(input))" — what about input = 0, "", false, null, undefined, NaN?
   - "if (value && processValue(value))" — zero or empty string skip validation
   - "if (!error && response)" — falsy check on potentially valid falsy values
   - "const x = y || defaultValue" — when y=0, "" or false is valid but gets replaced by default
   - For each falsy guard: list which legitimate falsy values would be incorrectly rejected

3. **Missing permission or authorization checks**
   - Endpoint checks "req.user" exists but never checks role (e.g., "req.user.role === 'admin'")
   - Resource access checks authentication but not authorization (does user OWN the resource?)
   - Admin functionality exposed without role verification
   - Each sensitive operation should have: authentication check AND authorization check

4. **Race conditions from read-then-write without synchronization**
   - "const current = await get(); await set(current + delta)" — non-atomic read-modify-write
   - Counter increments without locks, transactions, or atomic operations
   - Checking a condition then acting on it without a mutex
   - Look for: await get/fetch/read followed by await set/write/update/save on the same resource without transaction/lock/atomic

5. **Unvalidated external input used directly**
   - Values from query parameters, URL path segments, request headers used in database queries without sanitization
   - Third-party API response values used directly without validation
   - User input interpolated into shell commands, SQL, or rendered HTML
   - File upload names, sizes, or types used without validation

6. **Wrong default behavior in switch/case or if/else chains**
   - A default fallthrough case that is incorrect for the domain
   - An else branch that silently ignores an expected case
   - Error handling that catches and swallows specific errors but returns a generic success

Evaluation rules:
- If none of these patterns appear → PASS with reasoning that no subtle errors were detected
- If any pattern appears → FAIL with specific reasoning identifying the pattern, the potential failure scenario, and the concrete input that would trigger it
- The code may compile and look clean — the issue is behavioral correctness, not syntax
- Focus on actual risk: be specific about what would go wrong and under what conditions
- If the diff references external modules, config files, or functions not fully defined in the diff itself, use tools to read those files before making a judgment. Never say "need to examine" — use TOOL: readFile() or TOOL: searchFiles() to look.

Your final response MUST include a JSON object: {"passed": boolean, "reasoning": "detailed explanation"}`,
  severity: "blocker",
  path: "src/",
};

const BUILTIN_CODE_REUSE_BLINDNESS: Rule = {
  id: "code-reuse-blindness",
  description: `You are reviewing a code change for code reuse blindness — adding new utility functions, helpers, validation logic, or middleware that duplicates something already in the codebase.

Before making your final judgment, you MUST use workspace exploration tools to search for existing equivalents.

Patterns to look for:

1. **Duplicate utility functions**
   - A new function added to a utils/, helpers/, lib/, or common/ directory
   - Function name or purpose similar to something already in the codebase
   - SEARCH: use searchFiles() for the function name and key terms in its purpose

2. **Similar function names doing the same thing**
   - "formatDate()" vs "formatTimestamp()" vs "dateFormatter()"
   - "validateEmail()" vs "isValidEmail()" vs "checkEmail()"
   - "parseQuery()" vs "extractQueryParams()"
   - SEARCH: use searchFiles() for function names and semantic equivalents

3. **Validation logic reimplemented inline**
   - Validation checks added directly in a route handler or controller
   - Input sanitization reimplemented when a shared validator exists
   - SEARCH: use searchFiles() for "validate", "sanitize", "schema" in the same directory area

4. **Middleware reimplemented from scratch**
   - Auth checks inline in a handler when requireAuth() middleware exists
   - Rate limiting or logging added ad-hoc when middleware exists
   - SEARCH: use searchFiles() for "middleware", "auth", "requireAuth", "guard"

5. **"Almost the same" helpers**
   - A new helper that does 90% of what an existing helper does with different edge-case handling
   - SEARCH: use readFile() on the existing helper to compare behavior

How to use the tools:
- Respond with: TOOL: searchFiles("functionNameOrKeyword")
- Or: TOOL: globFiles("src/**/utils*")
- Or: TOOL: readFile("src/helpers/time.ts")

Evaluation rules:
- If the diff adds no new functions, helpers, middleware, or validation → PASS with reasoning that no new utilities were added
- If you find an existing equivalent through search → FAIL with specific reasoning identifying both the new function location and the existing equivalent
- If no equivalent exists after searching → PASS with reasoning that the new utility serves a genuinely unique purpose
- Functions that share a name but serve genuinely different purposes → PASS with explanation of the distinction

Your final response MUST include a JSON object: {"passed": boolean, "reasoning": "detailed explanation"}`,
  severity: "blocker",
  path: "src/",
};

const BUILT_IN_RULES: Rule[] = [
  BUILTIN_PROMPT_INJECTION,
  BUILTIN_AGENTIC_GHOSTING,
  BUILTIN_CI_GAMING,
  BUILTIN_HALLUCINATED_CORRECTNESS,
  BUILTIN_CODE_REUSE_BLINDNESS,
];

export function loadConfig(configPath = "hrev.yml"): Config {
  if (!existsSync(configPath)) {
    // No config file: return built-in detectors only
    return {
      model: undefined,
      rules: BUILT_IN_RULES,
    };
  }

  const content = readFileSync(configPath, "utf-8");
  const parsed = configSchema.parse(parse(content) as unknown);

  // Merge built-in rules with YAML rules. Built-in rules win on ID conflicts.
  const builtInIds = new Set(BUILT_IN_RULES.map((r) => r.id));
  const uniqueYamlRules = parsed.rules.filter((r) => !builtInIds.has(r.id));

  return {
    model: parsed.model,
    rules: [...BUILT_IN_RULES, ...uniqueYamlRules],
  };
}
