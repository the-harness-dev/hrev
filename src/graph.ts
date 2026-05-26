import { StateGraph, Annotation } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { Rule, ReviewResult, ReviewSummary, Diff, DiffFile } from "./types";
import { getDetectors, detectorToRule, isDetectorRuleId, getDetectorByRuleId } from "./detectors/index";
import { callModel, createChatModel } from "./model";
import {
  createWorkspaceContext,
  readFile,
  listFiles,
  globFiles,
  searchFiles,
  getWorkspaceToolsDescription,
} from "./workspace";
import { info, debug, warn, error as logError } from "./logger";

const ReviewVerdict = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
});

// Workflow interface to avoid 'any' for LangGraph integration
interface WorkflowGraph {
  addNode(name: string, fn: (state: typeof ReviewState.State) => Partial<typeof ReviewState.State> | Promise<Partial<typeof ReviewState.State>>): void;
  addEdge(from: string, to: string): void;
  addConditionalEdges(from: string, fn: () => string[]): void;
  compile(): CompiledGraph;
}

interface CompiledGraph {
  invoke(input: Partial<typeof ReviewState.State>): Promise<typeof ReviewState.State>;
}

const ReviewState = Annotation.Root({
  diff: Annotation<Diff>,
  rules: Annotation<Rule[]>,
  defaultModel: Annotation<string | undefined>,
  workspaceRoot: Annotation<string | undefined>,
  results: Annotation<ReviewResult[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  summary: Annotation<ReviewSummary | undefined>,
});

function diffContainsPath(files: DiffFile[], pathPrefix: string): boolean {
  const pathPrefixes = pathPrefix.split(",").map((p) => p.trim());
  return files.some((f) =>
    pathPrefixes.some((prefix) => f.path.startsWith(prefix))
  );
}

/**
 * Parse tool calls from model response and execute them.
 * Returns a list of tool results.
 */
function executeToolCalls(ctx: ReturnType<typeof createWorkspaceContext>, content: string): Array<{ tool: string; result: string }> {
  const results: Array<{ tool: string; result: string }> = [];

  // Match TOOL: readFile("...") or TOOL: listFiles("...")
  const toolRegex = /^TOOL:\s*(\w+)\("([^"]*)"\)/gm;
  let match;

  while ((match = toolRegex.exec(content)) !== null) {
    const [, toolName, arg] = match;
    debug("Executing tool", { tool: toolName, arg });

    try {
      switch (toolName) {
        case "readFile": {
          const contents = readFile(ctx, arg);
          results.push({
            tool: `readFile("${arg}")`,
            result: contents ?? "[File not found or not accessible]",
          });
          break;
        }
        case "listFiles": {
          const files = listFiles(ctx, arg);
          results.push({
            tool: `listFiles("${arg}")`,
            result: files.length > 0 ? files.join("\n") : "[Empty directory or not accessible]",
          });
          break;
        }
        case "globFiles": {
          const files = globFiles(ctx, arg);
          results.push({
            tool: `globFiles("${arg}")`,
            result: files.length > 0 ? files.join("\n") : "[No matches]",
          });
          break;
        }
        case "searchFiles": {
          const matches = searchFiles(ctx, arg, 10);
          results.push({
            tool: `searchFiles("${arg}")`,
            result: matches.length > 0
              ? matches.map((m) => `${m.file}:${String(m.line)}  ${m.text}`).join("\n")
              : "[No matches]",
          });
          break;
        }
        default:
          results.push({
            tool: `${toolName}("${arg}")`,
            result: `[Unknown tool: ${toolName}]`,
          });
      }
    } catch (error) {
      results.push({
        tool: `${toolName}("${arg}")`,
        result: `[Error: ${error instanceof Error ? error.message : String(error)}]`,
      });
    }
  }

  if (results.length > 0) {
    info("Tool calls executed", { count: results.length, tools: results.map((r) => ({ tool: r.tool, resultLen: r.result.length })) });
  }

  return results;
}

function createRuleNode(rule: Rule, defaultModel?: string, systemPromptOverride?: string) {
  return async (state: typeof ReviewState.State): Promise<Partial<typeof ReviewState.State>> => {
    info("Evaluating rule", { ruleId: rule.id, severity: rule.severity, path: rule.path, hasDiffContent: !!state.diff.raw, isDetector: !!systemPromptOverride });
    if (rule.path && !diffContainsPath(state.diff.files, rule.path)) {
      debug("Skipping rule", { ruleId: rule.id, reason: "path constraint not met", expected: rule.path });
      return {
        results: [{
          ruleId: rule.id,
          passed: true,
          reasoning: `Skipped: diff does not contain path ${rule.path}`,
          severity: rule.severity,
        }],
      };
    }

    const workspaceRoot = state.workspaceRoot || process.cwd();
    const ctx = createWorkspaceContext(workspaceRoot);
    const toolsDescription = getWorkspaceToolsDescription();

    const systemPrompt = systemPromptOverride
      ? `${systemPromptOverride}\n\n${toolsDescription}`
      : `You are reviewing a PROPOSED CHANGE (git diff) to an existing codebase. The rule
below describes a requirement the codebase must meet.

Your job: determine whether APPLYING this diff would BREAK or INTRODUCE a
violation of the rule.

- If the diff ADDS code that violates the rule, or REMOVES/MODIFIES code such
  that it no longer satisfies the rule → FAIL.
- If the diff does not touch the code relevant to this rule at all → PASS.
  (The rule may already be satisfied by existing code you cannot see.)
- If the diff is unrelated but adds a config/metadata reference to this rule
  (e.g., enabling it in a YAML config) → PASS. The diff is not required to
  re-implement behavior that already exists.

Rule ID: ${rule.id}
Rule: ${rule.description}
Severity: ${rule.severity}

${toolsDescription}

After any tool exploration, provide your final verdict:
If applying the diff WOULD introduce a violation, respond with:
{"passed": false, "reasoning": "specific explanation of the violation"}

If applying the diff would NOT introduce a violation, respond with:
{"passed": true, "reasoning": "explanation of why the change doesn't violate"}

Your final response MUST include the JSON object.`;

    const userPrompt = `Git diff to review:

${state.diff.raw}`;

    debug("Sending rule to model", { ruleId: rule.id, systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length, systemPrompt, userPrompt });
    try {
      let response = await callModel(systemPrompt, userPrompt, rule.model, defaultModel);
      let content = response.content.trim();

      debug("callModel returned", { ruleId: rule.id, contentLen: content.length, contentEmpty: content.length === 0 });

      let toolResults = executeToolCalls(ctx, content);
      let iterations = 0;
      const maxIterations = 3;

      // Detect when model wants to explore but wrote prose instead of TOOL: syntax
      const explorationPattern = /\b(I['\u2019]ll search|I['\u2019]ll examine|I need to (examine|search|check|read|verify|look)|let me (read|check|search)|TOOL)/i;
      const deferralPattern = /\b(need to (verify|examine|search|check|read|investigate|look|confirm)|pending verification|cannot (determine|assess|evaluate) without|insufficient (context|information))/i;
      const hasVerdictJson = content.includes('"passed"') || content.includes('{');
      if (toolResults.length === 0 && (
        (explorationPattern.test(content) && (!hasVerdictJson || content.indexOf('"passed"') > 100)) ||
        (hasVerdictJson && deferralPattern.test(content))
      )) {
        debug("Redirecting exploration prose to TOOL: syntax", { ruleId: rule.id, contentPreview: content.substring(0, 200), hasVerdict: hasVerdictJson });
        const redirectPrompt = `Use TOOL: command syntax to explore before giving your verdict. For example:
TOOL: searchFiles("functionName")
TOOL: readFile("src/config.ts")

Do NOT return a verdict that says "Need to verify" — use tools to verify instead.
The diff you are reviewing is:

${state.diff.raw}`;
        response = await callModel(systemPrompt, redirectPrompt, rule.model, defaultModel);
        content = response.content.trim();
        toolResults = executeToolCalls(ctx, content);
        debug("Redirect result", { ruleId: rule.id, newContentLen: content.length, toolResultsCount: toolResults.length });
      }

      while (toolResults.length > 0 && iterations < maxIterations) {
        const toolContext = toolResults.map((tr) =>
          `TOOL: ${tr.tool}\nRESULT:\n${tr.result}\n---`
        ).join("\n");

        const followUpPrompt = `You requested tools to explore the workspace. Here are the results:

${toolContext}

Now provide your final evaluation of the diff against the rule. The diff you are reviewing is:

${state.diff.raw}

Respond with JSON:
{"passed": boolean, "reasoning": "..."}`;

        response = await callModel(systemPrompt, followUpPrompt, rule.model, defaultModel);
        content = response.content.trim();

        toolResults = executeToolCalls(ctx, content);

        // Re-detect deferral prose inside loop — model saw tool results but still defers
        if (toolResults.length === 0 && deferralPattern.test(content) && iterations + 1 < maxIterations) {
          const retryPrompt = `You received tool results but wrote deferral text instead of using TOOL: syntax or giving a verdict. Use TOOL: commands to explore further, or provide your final JSON verdict now.
The diff you are reviewing is:

${state.diff.raw}`;
          response = await callModel(systemPrompt, retryPrompt, rule.model, defaultModel);
          content = response.content.trim();
          toolResults = executeToolCalls(ctx, content);
        }

        iterations++;
      }

      const verdict = await extractVerdict(content, systemPrompt, userPrompt, rule.model, defaultModel);

      info("Rule evaluated", { ruleId: rule.id, passed: verdict.passed, reasoningLen: verdict.reasoning.length, reasoning: verdict.reasoning });

      return {
        results: [{
          ruleId: rule.id,
          passed: verdict.passed,
          reasoning: verdict.reasoning,
          severity: rule.severity,
        }],
      };
    } catch (error) {
      logError("Rule evaluation failed", { ruleId: rule.id, err: error instanceof Error ? error.message : String(error) });
      return {
        results: [{
          ruleId: rule.id,
          passed: false,
          reasoning: `INTERNAL ERROR: ${error instanceof Error ? error.message : String(error)}`,
          severity: rule.severity,
        }],
      };
    }
  };
}

async function extractVerdict(
  content: string,
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  defaultModel?: string
): Promise<{ passed: boolean; reasoning: string }> {
  if (!content.trim()) {
    return {
      passed: false,
      reasoning: "Model returned an empty response — the evaluation could not be completed.",
    };
  }

  try {
    const jsonMatch = content.match(/```json\n?([\s\S]*?)```/) ||
                       content.match(/```\n?([\s\S]*?)```/) ||
                       [null, content];
    
    const jsonStr = jsonMatch[1].trim() || content;
    const rawResult = JSON.parse(jsonStr) as { passed: unknown; reasoning: unknown };
    return {
      passed: Boolean(rawResult.passed),
      reasoning: typeof rawResult.reasoning === "string" ? rawResult.reasoning : "No reasoning provided",
    };
  } catch (parseErr) {
    debug("Failed to parse verdict JSON, falling back to structured output", { contentPreview: content.substring(0, 200), parseErr: String(parseErr) });

    try {
      const verdictModel = createChatModel(model, defaultModel).withStructuredOutput(ReviewVerdict, {
        name: "review_verdict",
        method: "functionCalling",
      });

      const result = await verdictModel.invoke([
        new SystemMessage(`Rephrase the following content into a review verdict JSON with fields "passed" (boolean) and "reasoning" (string).`),
        new HumanMessage(content),
      ]);

      if (typeof result.passed === "boolean") {
        return {
          passed: result.passed,
          reasoning: result.reasoning || "No reasoning provided",
        };
      }
    } catch {
      // fall through to raw content extraction
      debug("Structured output fallback failed", { contentPreview: content.substring(0, 200) });
    }

    warn("Unparseable verdict content", { contentPreview: content.substring(0, 500), contentLen: content.length });
    return {
      passed: false,
      reasoning: `Model returned non-JSON response: ${content.substring(0, 500)}`,
    };
  }
}

function aggregatorNode(state: typeof ReviewState.State): Partial<typeof ReviewState.State> {
  const results = state.results;
  info("Aggregating results", { resultCount: results.length });
  const failedBlockers = results.filter((r) => !r.passed && r.severity === "blocker");
  const failedGeneral = results.filter((r) => !r.passed && r.severity === "general");
  const failedNits = results.filter((r) => !r.passed && r.severity === "nit");

  const passed = failedBlockers.length === 0;
  info("Aggregation complete", { passed, blockerFails: failedBlockers.length, generalFails: failedGeneral.length, nitFails: failedNits.length });

  const summaryLines: string[] = [
    "═".repeat(60),
    "  AI Code Review Results",
    "═".repeat(60),
    "",
    `${String(results.length)} rules evaluated`,
    `  ❌ Blockers failed: ${String(failedBlockers.length)}`,
    `  ⚠️  General failed: ${String(failedGeneral.length)}`,
    `  💡 Nits: ${String(failedNits.length)}`,
    "",
    `Overall: ${passed ? "✅ PASSED" : "❌ FAILED"}`,
    "",
  ];

  const failedRules = results.filter((r) => !r.passed);
  if (failedRules.length > 0) {
    summaryLines.push("Failed Rules:");
    for (const r of failedRules) {
      const icon = r.severity === "blocker" ? "❌" : r.severity === "general" ? "⚠️" : "💡";
      summaryLines.push(`  ${icon} [${r.severity.toUpperCase()}] ${r.ruleId}`);
      summaryLines.push(`     ${r.reasoning}`);
    }
  }

  summaryLines.push("", "═".repeat(60));

  return {
    summary: {
      passed,
      results,
      summary: summaryLines.join("\n"),
    },
  };
}

export interface ReviewOptions {
  enableDetectors?: boolean;
  enableUserRules?: boolean;
  filterRuleId?: string;
}

export async function runReview(
  diff: Diff,
  rules: Rule[],
  defaultModel?: string,
  workspaceRoot?: string,
  options?: ReviewOptions
): Promise<ReviewSummary> {
  if (!diff.raw || diff.raw.trim().length === 0) {
    throw new Error("Diff is empty — nothing to review. Make sure your git diff contains changes, or check that your base/head refs are correct.");
  }

  const enableDetectors = options?.enableDetectors !== false;
  const enableUserRules = options?.enableUserRules !== false;

  const allRules: Rule[] = [];

  if (enableDetectors) {
    const detectors = getDetectors();
    for (const detector of detectors) {
      allRules.push(detectorToRule(detector));
    }
  }

  if (enableUserRules) {
    allRules.push(...rules);
  }

  if (allRules.length === 0) {
    throw new Error("No rules or detectors to evaluate.");
  }

  const filterRuleId = options?.filterRuleId;
  const filteredRules = filterRuleId
    ? allRules.filter((r) => r.id === filterRuleId || r.id.endsWith("/" + filterRuleId))
    : allRules;

  if (filteredRules.length === 0) {
    throw new Error(`No rules found matching ID "${filterRuleId}"`);
  }

  // Batch execution to avoid MaxListenersExceededWarning from parallel AbortControllers
  const BATCH_SIZE = 8;
  const allResults: ReviewResult[] = [];

  for (let i = 0; i < filteredRules.length; i += BATCH_SIZE) {
    const batch = filteredRules.slice(i, i + BATCH_SIZE);

    const workflow = new StateGraph(ReviewState) as unknown as WorkflowGraph;

    for (const rule of batch) {
      const isDetector = isDetectorRuleId(rule.id);
      const detector = isDetector ? getDetectorByRuleId(rule.id) : undefined;
      const systemPrompt = detector?.systemPrompt;
      workflow.addNode(`rule_${rule.id}`, createRuleNode(rule, defaultModel, systemPrompt));
    }

    const batchNodeIds = batch.map((r) => `rule_${r.id}`);
    workflow.addConditionalEdges("__start__", () => batchNodeIds);

    for (const nodeId of batchNodeIds) {
      workflow.addEdge(nodeId, "__end__");
    }

    const graph = workflow.compile();

    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allRules.length / BATCH_SIZE);
    info("Running review batch", { batch: `${batchIndex}/${totalBatches}`, batchSize: batch.length });

    const result = await graph.invoke({
      diff,
      rules: batch,
      defaultModel,
      workspaceRoot,
      results: [],
      summary: undefined,
    });

    allResults.push(...result.results);
  }

  const failedBlockers = allResults.filter((r) => !r.passed && r.severity === "blocker");
  const failedGeneral = allResults.filter((r) => !r.passed && r.severity === "general");
  const failedNits = allResults.filter((r) => !r.passed && r.severity === "nit");

  const passed = failedBlockers.length === 0;
  info("Review batches complete", { totalResults: allResults.length, passed, blockerFails: failedBlockers.length, generalFails: failedGeneral.length, nitFails: failedNits.length });

  const summaryLines: string[] = [
    "═".repeat(60),
    "  AI Code Review Results",
    "═".repeat(60),
    "",
    `${String(allResults.length)} rules evaluated`,
    `  ❌ Blockers failed: ${String(failedBlockers.length)}`,
    `  ⚠️  General failed: ${String(failedGeneral.length)}`,
    `  💡 Nits: ${String(failedNits.length)}`,
    "",
    `Overall: ${passed ? "✅ PASSED" : "❌ FAILED"}`,
    "",
  ];

  const failedRules = allResults.filter((r) => !r.passed);
  if (failedRules.length > 0) {
    summaryLines.push("Failed Rules:");
    for (const r of failedRules) {
      const icon = r.severity === "blocker" ? "❌" : r.severity === "general" ? "⚠️" : "💡";
      summaryLines.push(`  ${icon} [${r.severity.toUpperCase()}] ${r.ruleId}`);
      summaryLines.push(`     ${r.reasoning}`);
    }
  }

  summaryLines.push("", "═".repeat(60));

  return {
    passed,
    results: allResults,
    summary: summaryLines.join("\n"),
  };
}
