import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { Rule, ReviewResult, ReviewSummary, Diff, DiffFile } from "./types";
import { callModel } from "./model";

const ReviewState = Annotation.Root({
  diff: Annotation<Diff>,
  rules: Annotation<Rule[]>,
  defaultModel: Annotation<string | undefined>,
  results: Annotation<ReviewResult[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  summary: Annotation<ReviewSummary | undefined>,
});

function diffContainsPath(files: DiffFile[], pathPrefix: string): boolean {
  return files.some((f) => f.path.startsWith(pathPrefix));
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

    const systemPrompt = `You are a code reviewer. Evaluate the following git diff against this rule.

Rule ID: ${rule.id}
Rule: ${rule.description}
Severity: ${rule.severity}

If the diff violates the rule, respond with a JSON object:
{"passed": false, "reasoning": "specific explanation of the violation"}

If the diff complies with the rule, respond with:
{"passed": true, "reasoning": "explanation of why it complies"}

Respond with ONLY the JSON object, no other text.`;

    const userPrompt = `Git diff to review:\n\n${state.diff.raw}`;

    try {
      const response = await callModel(systemPrompt, userPrompt, rule.model || defaultModel);
      const content = response.content.trim();
      
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

export async function runReview(diff: Diff, rules: Rule[], defaultModel?: string): Promise<ReviewSummary> {
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
    results: [],
    summary: undefined,
  });

  if (!result.summary) {
    throw new Error("Review did not produce a summary");
  }

  return result.summary;
}
