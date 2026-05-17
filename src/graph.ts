import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { Rule, ReviewResult, ReviewSummary, Diff, DiffFile } from "./types";
import { callModel } from "./model";
import {
  createWorkspaceContext,
  readFile,
  listFiles,
  globFiles,
  searchFiles,
  getWorkspaceToolsDescription,
} from "./workspace";

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
  return files.some((f) => f.path.startsWith(pathPrefix));
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
              ? matches.map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n")
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

  return results;
}

function createRuleNode(rule: Rule, defaultModel?: string) {
  return async (state: typeof ReviewState.State): Promise<Partial<typeof ReviewState.State>> => {
    // Skip if path constraint not met
    if (rule.path && !diffContainsPath(state.diff.files, rule.path)) {
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

    const systemPrompt = `You are a code reviewer. Evaluate the following git diff against this rule.

Rule ID: ${rule.id}
Rule: ${rule.description}
Severity: ${rule.severity}

${toolsDescription}

After any tool exploration, provide your final verdict as JSON:
{"passed": false, "reasoning": "specific explanation of the violation"}

OR

{"passed": true, "reasoning": "explanation of why it complies"}

Your final response MUST include the JSON object.`;

    const userPrompt = `Git diff to review:

${state.diff.raw}`;

    try {
      // First call - model may request tool usage
      let response = await callModel(systemPrompt, userPrompt, rule.model || defaultModel);
      let content = response.content.trim();

      // Check for tool calls and execute them
      let toolResults = executeToolCalls(ctx, content);
      let iterations = 0;
      const maxIterations = 3;

      while (toolResults.length > 0 && iterations < maxIterations) {
        // Build follow-up prompt with tool results
        const toolContext = toolResults.map((tr) =>
          `TOOL: ${tr.tool}\nRESULT:\n${tr.result}\n---`
        ).join("\n");

        const followUpPrompt = `You requested tools to explore the workspace. Here are the results:

${toolContext}

Now provide your final evaluation of the diff against the rule. Respond with JSON:
{"passed": boolean, "reasoning": "..."}`;

        response = await callModel(systemPrompt, followUpPrompt, rule.model || defaultModel);
        content = response.content.trim();

        // Check if more tool calls
        toolResults = executeToolCalls(ctx, content);
        iterations++;
      }

      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```json\n?([\s\S]*?)```/) ||
                         content.match(/```\n?([\s\S]*?)```/) ||
                         [null, content];

      const jsonStr = jsonMatch[1]?.trim() || content;
      const parsed = JSON.parse(jsonStr);

      return {
        results: [{
          ruleId: rule.id,
          passed: Boolean(parsed.passed),
          reasoning: String(parsed.reasoning || "No reasoning provided"),
          severity: rule.severity,
        }],
      };
    } catch (error) {
      return {
        results: [{
          ruleId: rule.id,
          passed: true,
          reasoning: `Error evaluating rule: ${error instanceof Error ? error.message : String(error)}`,
          severity: rule.severity,
        }],
      };
    }
  };
}

async function aggregatorNode(state: typeof ReviewState.State): Promise<Partial<typeof ReviewState.State>> {
  const results = state.results;
  const failedBlockers = results.filter((r) => !r.passed && r.severity === "blocker");
  const failedGeneral = results.filter((r) => !r.passed && r.severity === "general");
  const failedNits = results.filter((r) => !r.passed && r.severity === "nit");

  const passed = failedBlockers.length === 0;

  const summaryLines: string[] = [
    "═".repeat(60),
    "  AI Code Review Results",
    "═".repeat(60),
    "",
    `${results.length} rules evaluated`,
    `  ❌ Blockers failed: ${failedBlockers.length}`,
    `  ⚠️  General failed: ${failedGeneral.length}`,
    `  💡 Nits: ${failedNits.length}`,
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

export async function runReview(
  diff: Diff,
  rules: Rule[],
  defaultModel?: string,
  workspaceRoot?: string
): Promise<ReviewSummary> {
  // Build the graph with dynamic nodes using 'any' to bypass strict literal types
  const workflow = new StateGraph(ReviewState) as any;

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
