#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "fs";
import { loadConfig } from "./config";
import { getGitDiff, parseDiff } from "./diff";
import { runReview } from "./graph";

const program = new Command();

program
  .name("hrev")
  .description("AI-powered rules-based code review")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to config file", "hrev.yml")
  .option("--base <branch>", "Base branch for comparison")
  .option("--head <branch>", "Head branch for comparison")
  .option("--diff <path>", "Path to a pre-generated diff file")
  .option("-v, --verbose", "Show per-rule evaluation details")
  .option("--json", "Output results as JSON for programmatic use")
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      
      let diff;
      if (options.diff) {
        const raw = readFileSync(options.diff, "utf-8");
        diff = parseDiff(raw);
      } else {
        diff = getGitDiff(options.base, options.head);
      }
      
      const summary = await runReview(diff, config.rules, config.model);
      
      if (options.json) {
        const output = {
          passed: summary.passed,
          results: summary.results,
          summary: summary.summary,
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        if (options.verbose) {
          console.log("\n📋 Per-Rule Details:");
          for (const r of summary.results) {
            const icon = r.passed ? "✅" : "❌";
            const sev = `[${r.severity.toUpperCase()}]`;
            console.log(`  ${icon} ${sev} ${r.ruleId}`);
            console.log(`     → ${r.reasoning}`);
          }
          console.log("");
        }
        
        console.log(summary.summary);
      }
      
      process.exit(summary.passed ? 0 : 1);
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } else {
        console.error("Error:", error instanceof Error ? error.message : String(error));
      }
      process.exit(1);
    }
  });

program.parse();
