import { Detector } from "../types";

export const promptInjectionDetector: Detector = {
  id: "prompt-injection",
  description: "Detect GitHub Actions workflow patterns vulnerable to prompt injection: untrusted input interpolated into LLM prompts, overly permissive GITHUB_TOKEN, model output piped to shell, and secrets exposed to agent steps or logs.",
  severity: "blocker",
  path: ".github/workflows/",
  systemPrompt: `You are reviewing a GitHub Actions workflow for prompt injection vulnerabilities — patterns where untrusted input can reach an LLM prompt or where the workflow has excessive permissions.

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
};
