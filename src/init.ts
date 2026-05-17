import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import inquirer from "inquirer";
import YAML from "yaml";
import { spawnSubAgent } from "./subagent";

const STUB_CONFIG = `# hrev configuration
# Define semantic rules for AI-powered code review
# Each rule is evaluated independently in parallel

model: gpt-4o

rules:
  - id: example-rule
    description: "Describe what this rule checks in plain English. Be specific about what the code should or should not do."
    severity: general
    # Optional: only check diffs touching this path
    # path: "src/services/"
`;

const GITHUB_WORKFLOW = `name: Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  statuses: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: the-harness-dev/hrev@v1
        with:
          api-key: \${{ secrets.HREV_API_KEY }}
          comment: true
          status: true
`;

const ENV_TEMPLATE = `# hrev environment configuration
# Get your API key from your model provider

HREV_API_URL=https://api.openai.com/v1
HREV_API_KEY=your-api-key-here
# HREV_MODEL=gpt-4o
`;

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getGitOrigin(): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return url;
  } catch {
    return null;
  }
}

function isGitHubOrigin(url: string): boolean {
  return url.includes("github.com") || url.includes("github:");
}

function extractRepoInfo(url: string): { owner: string; repo: string } | null {
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

interface RecommendedRule {
  id: string;
  description: string;
  severity: "nit" | "general" | "blocker";
  path?: string;
  rationale: string;
}

export async function runInit(): Promise<void> {
  console.log("\n🌿 Welcome to hrev! Let's set up your project.\n");

  // Step 1: Create hrev.yml
  const configPath = join(process.cwd(), "hrev.yml");
  let config: any = {};

  if (existsSync(configPath)) {
    console.log("✓ hrev.yml already exists.");
    try {
      const existing = readFileSync(configPath, "utf-8");
      config = YAML.parse(existing);
    } catch {
      // ignore parse errors
    }
  } else {
    console.log("Creating hrev.yml...");
    writeFileSync(configPath, STUB_CONFIG);
    console.log("✓ Created hrev.yml");
    config = YAML.parse(STUB_CONFIG);
  }

  // Step 2: Detect git and GitHub
  const isGit = isGitRepo();
  let isGitHub = false;
  let repoInfo: { owner: string; repo: string } | null = null;

  if (isGit) {
    const origin = getGitOrigin();
    if (origin) {
      console.log(`\n✓ Git repository detected (origin: ${origin})`);
      isGitHub = isGitHubOrigin(origin);
      if (isGitHub) {
        repoInfo = extractRepoInfo(origin);
        console.log(`✓ GitHub repository detected`);
      }
    } else {
      console.log("\n✓ Git repository detected (no remote)");
    }
  } else {
    console.log("\n⚠ Not a git repository.");
  }

  // Step 3: GitHub Actions setup
  if (isGitHub && repoInfo) {
    const workflowPath = join(process.cwd(), ".github", "workflows", "hrev.yml");

    if (existsSync(workflowPath)) {
      console.log("\n✓ GitHub Actions workflow already exists.");
    } else {
      const { setupWorkflow } = await inquirer.prompt([
        {
          type: "confirm",
          name: "setupWorkflow",
          message: `Set up GitHub Actions workflow for PR reviews in ${repoInfo.owner}/${repoInfo.repo}?`,
          default: true,
        },
      ]);

      if (setupWorkflow) {
        mkdirSync(dirname(workflowPath), { recursive: true });
        writeFileSync(workflowPath, GITHUB_WORKFLOW);
        console.log("✓ Created .github/workflows/hrev.yml");
        console.log("  Make sure to add HREV_API_KEY to your repo secrets!");
      }
    }
  }

  // Step 4: Local env setup
  if (isGit) {
    const { setupLocal } = await inquirer.prompt([
      {
        type: "confirm",
        name: "setupLocal",
        message: "Set up local environment file (.env) for running hrev locally?",
        default: true,
      },
    ]);

    if (setupLocal) {
      const envPath = join(process.cwd(), ".env");
      const gitignorePath = join(process.cwd(), ".gitignore");

      if (existsSync(envPath)) {
        console.log("\n✓ .env already exists.");
      } else {
        writeFileSync(envPath, ENV_TEMPLATE);
        console.log("\n✓ Created .env");
      }

      // Update .gitignore
      if (existsSync(gitignorePath)) {
        const gitignore = readFileSync(gitignorePath, "utf-8");
        if (!gitignore.includes(".env")) {
          writeFileSync(gitignorePath, gitignore + "\n.env\n");
          console.log("✓ Added .env to .gitignore");
        } else {
          console.log("✓ .env already in .gitignore");
        }
      } else {
        writeFileSync(gitignorePath, ".env\n");
        console.log("✓ Created .gitignore with .env");
      }

      // Ask for API key
      const { apiKey } = await inquirer.prompt([
        {
          type: "input",
          name: "apiKey",
          message: "Enter your API key (or press Enter to skip):",
        },
      ]);

      if (apiKey) {
        let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : ENV_TEMPLATE;
        envContent = envContent.replace(
          /HREV_API_KEY=.*/,
          `HREV_API_KEY=${apiKey}`
        );
        writeFileSync(envPath, envContent);
        console.log("✓ API key saved to .env");
      }
    }
  }

  // Step 5: Recommend rules using AI agent
  const { recommendRules } = await inquirer.prompt([
    {
      type: "confirm",
      name: "recommendRules",
      message: "Would you like to spawn an AI agent to recommend semantic rules from your docs?",
      default: true,
    },
  ]);

  if (recommendRules) {
    console.log("\n🤖 Spawning agent to analyze project docs...\n");
    
    const newRules = await spawnSubAgent(process.cwd());

    if (newRules.length > 0) {
      console.log(`\nFound ${newRules.length} potential semantic rules:\n`);
      for (const rule of newRules) {
        const pathStr = rule.path ? ` [${rule.path}]` : "";
        console.log(`  [${rule.severity.toUpperCase()}] ${rule.description.substring(0, 80)}${rule.description.length > 80 ? "..." : ""}${pathStr}`);
      }

      const { selected } = await inquirer.prompt([
        {
          type: "checkbox",
          name: "selected",
          message: "Select rules to add to hrev.yml:",
          choices: newRules.map((r, i) => ({
            name: `[${r.severity.toUpperCase()}] ${r.description.substring(0, 60)}${r.description.length > 60 ? "..." : ""}`,
            value: i,
            checked: true,
          })),
        },
      ]);

      if (selected.length > 0) {
        const existingRules = config.rules || [];
        for (const idx of selected) {
          const rule = newRules[idx];
          existingRules.push({
            id: rule.id,
            description: rule.description,
            severity: rule.severity,
            ...(rule.path && { path: rule.path }),
          });
        }
        config.rules = existingRules;
        writeFileSync(configPath, YAML.stringify(config));

        console.log(`\n✓ Added ${selected.length} rule(s) to hrev.yml`);
        console.log("\n📋 Rules added:");
        for (const idx of selected) {
          const rule = newRules[idx];
          console.log(`  • ${rule.id} (${rule.severity})`);
          console.log(`    ${rule.description.substring(0, 100)}${rule.description.length > 100 ? "..." : ""}`);
          console.log(`    Why: ${rule.rationale}`);
        }
      } else {
        console.log("\nNo rules selected.");
      }
    } else {
      console.log("\nNo semantic rules found in documentation.");
    }
  }

  console.log("\n✨ Setup complete! Run `hrev` to review your code.");
  if (isGitHub) {
    console.log("   On pull requests, the action will run automatically.");
  }
  console.log("");
}
