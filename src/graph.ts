import { StateGraph, Annotation } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { Rule, ReviewResult, ReviewSummary, Diff, DiffFile } from "./types";
import { callModelWithMessages } from "./model";
import { parseVerdictFromContent } from "./parse-json";
import {
  createWorkspaceContext,
  readFile,
  listFiles,
  globFiles,
  searchFiles,
  getWorkspaceToolsDescription,
} from "./workspace";
import { info, debug, error as logError } from "./logger";

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

function diffContainsPath(files: DiffFile[], pathSpec: string): boolean {
  // Handle comma-separated paths: "src/,dist/" means any of src/ OR dist/
  const prefixes = pathSpec.includes(",")
    ? pathSpec.split(",").map((s) => s.trim()).filter(Boolean)
    : [pathSpec];
  return files.some((f) =>
    prefixes.some((prefix) => f.path.startsWith(prefix))
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

function createRuleNode(rule: Rule, defaultModel?: string) {
  return async (state: typeof ReviewState.State): Promise<Partial<typeof ReviewState.State>> => {
    info("Evaluating rule", { ruleId: rule.id, severity: rule.severity, path: rule.path, hasDiffContent: !!state.diff.raw });
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

    const systemPrompt = `You are reviewing a PROPOSED CHANGE (git diff) to an existing codebase. The rule
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

${state.diff.raw}${state.diff.description ? `

Change description:
${state.diff.description}` : ""}`;

    // Build conversation history as LangChain BaseMessages
    const messages: (SystemMessage | HumanMessage | AIMessage)[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];

    debug("Sending rule to model", { ruleId: rule.id, systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length, systemPrompt, userPrompt });
    try {
      let response = await callModelWithMessages(messages, rule.model, defaultModel);
      let content = response.content.trim();

      let toolResults = executeToolCalls(ctx, content);
      let iterations = 0;
      const maxIterations = 5;

      while (iterations < maxIterations) {
        const verdict = parseVerdictFromContent(content);
        if (verdict) {
          info("Rule evaluated", { ruleId: rule.id, passed: verdict.passed, reasoningLen: verdict.reasoning.length, reasoning: verdict.reasoning });
          return {
            results: [{
              ruleId: rule.id,
              passed: verdict.passed,
              reasoning: verdict.reasoning,
              severity: rule.severity,
            }],
          };
        }

        if (toolResults.length > 0) {
          // Record the model's tool request as an AI message
          messages.push(new AIMessage(content));

          const toolContext = toolResults.map((tr) =>
            `TOOL: ${tr.tool}\nRESULT:\n${tr.result}\n---`
          ).join("\n");

          const followUpPrompt = `You requested tools to explore the workspace. Here are the results:

${toolContext}

Original git diff to review (for reference):

${state.diff.raw}${state.diff.description ? `

Change description (for reference):
${state.diff.description}` : ""}

Now provide your final evaluation of the diff against the rule. Respond with JSON:
{"passed": boolean, "reasoning": "..."}`;

          messages.push(new HumanMessage(followUpPrompt));
        } else {
          // No valid verdict and no tools requested — prompt again
          messages.push(new AIMessage(content));
          messages.push(new HumanMessage(`You have not yet provided a verdict. Evaluate the diff against the rule and respond ONLY with a JSON object:

{"passed": boolean, "reasoning": "..."}

No other text.`));
        }

        response = await callModelWithMessages(messages, rule.model, defaultModel);
        content = response.content.trim();
        toolResults = executeToolCalls(ctx, content);
        iterations++;
      }

      const verdict = extractVerdict(content);

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

function extractVerdict(content: string): { passed: boolean; reasoning: string } {
  const verdict = parseVerdictFromContent(content);
  if (verdict) return verdict;

  if (!content.trim()) {
    return {
      passed: false,
      reasoning: "Model returned an empty response — the evaluation could not be completed.",
    };
  }

  return {
    passed: false,
    reasoning: `Model returned non-JSON response: ${content.substring(0, 500)}`,
  };
}

export function aggregateResults(results: ReviewResult[]): { passed: boolean; results: ReviewResult[]; summary: string } {
  const failedBlockers = results.filter((r) => !r.passed && r.severity === "blocker");
  const failedGeneral = results.filter((r) => !r.passed && r.severity === "general");
  const failedNits = results.filter((r) => !r.passed && r.severity === "nit");

  const passed = failedBlockers.length === 0;

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
    passed,
    results,
    summary: summaryLines.join("\n"),
  };
}

function aggregatorNode(state: typeof ReviewState.State): Partial<typeof ReviewState.State> {
  info("Aggregating results", { resultCount: state.results.length });
  const failedBlockers = state.results.filter((r) => !r.passed && r.severity === "blocker");
  const failedGeneral = state.results.filter((r) => !r.passed && r.severity === "general");
  const failedNits = state.results.filter((r) => !r.passed && r.severity === "nit");
  const passed = failedBlockers.length === 0;
  info("Aggregation complete", { passed, blockerFails: failedBlockers.length, generalFails: failedGeneral.length, nitFails: failedNits.length });
  return {
    summary: aggregateResults(state.results),
  };
}

export async function runReview(
  diff: Diff,
  rules: Rule[],
  defaultModel?: string,
  workspaceRoot?: string
): Promise<ReviewSummary> {
  if (!diff.raw || diff.raw.trim().length === 0) {
    throw new Error("Diff is empty — nothing to review. Make sure your git diff contains changes, or check that your base/head refs are correct.");
  }

  const workflow = new StateGraph(ReviewState) as unknown as WorkflowGraph;

  // Add parallel rule nodes
  for (const rule of rules) {
    workflow.addNode(`rule_${rule.id}`, createRuleNode(rule, defaultModel));
  }

  // Add aggregator node
  workflow.addNode("aggregator", aggregatorNode);

  // Fan out from start to all rule nodes in parallel
  const ruleNodeIds = rules.map((r) => `rule_${r.id}`);
  workflow.addConditionalEdges("__start__", () => ruleNodeIds);

  // All rule nodes converge to aggregator
  for (const nodeId of ruleNodeIds) {
    workflow.addEdge(nodeId, "aggregator");
  }

  // Aggregator ends the flow
  workflow.addEdge("aggregator", "__end__");

  const graph = workflow.compile();

  // Run the graph
  const result = await graph.invoke({
    diff,
    rules,
    defaultModel,
    workspaceRoot,
    results: [],
    summary: undefined,
  });

  if (!result.summary) {
    throw new Error("Review did not produce a summary");
  }

  return result.summary;
}
