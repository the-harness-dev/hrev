#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { runInit } from "./init";
import { Command } from "commander";
import { readFileSync } from "fs";
import { loadConfig } from "./config";
import { getGitDiff, parseDiff } from "./diff";
import { runReview } from "./graph";
import { isDetectorRuleId } from "./detectors/index";
import { getLogPath, info } from "./logger";

interface ReviewOptions {
  config: string;
  base?: string;
  head?: string;
  diff?: string;
  verbose?: boolean;
  json?: boolean;
  debug?: boolean;
  detectors?: boolean;
  detectorsOnly?: boolean;
}

const program = new Command();

program
  .command("init")
  .description("Initialize hrev in your project (create config, setup GitHub Actions, etc.)")
  .option("--debug", "Enable debug logging to /tmp/hrev-logs/")
  .action(async (options: { debug?: boolean }) => {
    if (options.debug) {
      console.log(`Debug log: ${getLogPath()}`);
    }
    try {
      await runInit();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

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
  .option("--debug", "Enable debug logging to /tmp/hrev-logs/")
  .option("--no-detectors", "Skip built-in detectors, only run user rules")
  .option("--detectors-only", "Only run built-in detectors, skip user rules")
  .action(async (options: ReviewOptions) => {
    if (options.debug) {
      console.log(`Debug log: ${getLogPath()}`);
      info("Review started with debug");
    }
    try {
      const config = loadConfig(options.config);
      
      let diff;
      if (options.diff) {
        const raw = readFileSync(options.diff, "utf-8");
        diff = parseDiff(raw);
      } else {
        diff = getGitDiff(options.base, options.head);
      }

      const reviewOptions = {
        enableDetectors: options.detectors !== false,
        enableUserRules: !options.detectorsOnly,
      };
      
      const summary = await runReview(diff, config.rules, config.model, process.cwd(), reviewOptions);
      
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
            const detectorPrefix = isDetectorRuleId(r.ruleId) ? "[DETECTOR] " : "";
            console.log(`  ${icon} ${sev} ${detectorPrefix}${r.ruleId}`);
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
