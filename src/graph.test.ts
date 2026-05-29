import { test, describe } from "node:test";
import assert from "node:assert";
import { aggregateResults } from "./graph";
import { ReviewResult } from "./types";

describe("aggregateResults", () => {
  test("passes when all blockers pass", () => {
    const results: ReviewResult[] = [
      { ruleId: "a", passed: true, reasoning: "ok", severity: "blocker" },
      { ruleId: "b", passed: true, reasoning: "ok", severity: "general" },
      { ruleId: "c", passed: true, reasoning: "ok", severity: "nit" },
    ];
    const summary = aggregateResults(results);
    assert.strictEqual(summary.passed, true);
    assert.ok(summary.summary.includes("✅ PASSED"));
  });

  test("fails when any blocker fails", () => {
    const results: ReviewResult[] = [
      { ruleId: "a", passed: true, reasoning: "ok", severity: "blocker" },
      { ruleId: "b", passed: false, reasoning: "bad", severity: "blocker" },
      { ruleId: "c", passed: true, reasoning: "ok", severity: "general" },
    ];
    const summary = aggregateResults(results);
    assert.strictEqual(summary.passed, false);
    assert.ok(summary.summary.includes("❌ FAILED"));
  });

  test("general failures do not block", () => {
    const results: ReviewResult[] = [
      { ruleId: "a", passed: true, reasoning: "ok", severity: "blocker" },
      { ruleId: "b", passed: false, reasoning: "warn", severity: "general" },
      { ruleId: "c", passed: false, reasoning: "suggestion", severity: "nit" },
    ];
    const summary = aggregateResults(results);
    assert.strictEqual(summary.passed, true);
  });

  test("nit failures do not block", () => {
    const results: ReviewResult[] = [
      { ruleId: "a", passed: true, reasoning: "ok", severity: "blocker" },
      { ruleId: "b", passed: false, reasoning: "tip", severity: "nit" },
    ];
    const summary = aggregateResults(results);
    assert.strictEqual(summary.passed, true);
  });

  test("reports per-rule failure details in summary", () => {
    const results: ReviewResult[] = [
      { ruleId: "test-rule", passed: false, reasoning: "Found an issue", severity: "blocker" },
    ];
    const summary = aggregateResults(results);
    assert.ok(summary.summary.includes("test-rule"));
    assert.ok(summary.summary.includes("Found an issue"));
  });
});
