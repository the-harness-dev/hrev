import { readFileSync } from "fs";
import { join } from "path";
import { callModel } from "./model";

interface RecommendedRule {
  id: string;
  description: string;
  severity: "nit" | "general" | "blocker";
  path?: string;
  rationale: string;
}

const AGENT_SYSTEM_PROMPT = `You are a code review architect agent. Your job is to analyze project documentation and identify semantic rules — architectural invariants, design patterns, and cross-cutting concerns that CANNOT be caught by a static linter or type checker.

Focus ONLY on code-quality rules about:
- Architecture (layer boundaries, dependency direction, proxy patterns)
- Data integrity (invariants, balance constraints, validation rules)
- Design patterns (MCP-first, document-centric, API-first)
- API contracts (response formats, header requirements, auth patterns)
- Security boundaries (frontend/backend separation, no direct DB access)

IGNORE:
- Style/formatting (indentation, naming conventions, line length)
- Dead code detection ("delete unused", "remove legacy")
- Git workflow ("git add", "stage files", "before commit")
- Business domain requirements (tax codes, rates, compliance specifics)
- General mandates ("write tests", "minimum coverage")

For each rule, provide:
- id: kebab-case identifier
- description: Plain English, imperative, specific enough for an AI to evaluate
- severity: blocker | general | nit
- path: Optional directory constraint (only check diffs touching this path)
- rationale: Why this rule matters, citing the doc

Return ONLY valid JSON:
{
  "rules": [
    {
      "id": "document-centric-architecture",
      "description": "Never insert directly into aggregate tables. Always create source documents first and use edge methods.",
      "severity": "blocker",
      "path": "internal/service/",
      "rationale": "AGENTS.md states source documents are truth and aggregates are derived"
    }
  ]
}
`;

function findMarkdownFiles(dir: string, depth = 0): string[] {
  const { execSync } = require("child_process");
  
  if (depth > 2) return [];

  const files: string[] = [];
  try {
    const entries = execSync(`ls -1 "${dir}" 2>/dev/null || true`, { encoding: "utf-8" }).split("\n");

    for (const entry of entries) {
      if (!entry.trim()) continue;
      const fullPath = join(dir, entry);

      if (entry.endsWith(".md") && !entry.includes("node_modules")) {
        files.push(fullPath);
      } else if (
        depth < 2 &&
        !entry.startsWith(".") &&
        !entry.includes("node_modules") &&
        !entry.includes(".venv") &&
        !entry.includes("vendor") &&
        !entry.includes("dist") &&
        !entry.includes("build")
      ) {
        try {
          const stat = execSync(`test -d "${fullPath}" && echo "dir" || echo "file"`, { encoding: "utf-8" }).trim();
          if (stat === "dir") {
            files.push(...findMarkdownFiles(fullPath, depth + 1));
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore errors
  }

  return files;
}

export async function spawnSubAgent(projectDir: string): Promise<RecommendedRule[]> {
  const markdownFiles = findMarkdownFiles(projectDir);

  let docsContent = "";
  for (const file of markdownFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      if (content.length < 50000) {
        docsContent += `\n\n--- FILE: ${file} ---\n\n${content}`;
      }
    } catch {
      // skip unreadable files
    }
  }

  if (!docsContent.trim()) {
    return [];
  }

  const response = await callModel(
    AGENT_SYSTEM_PROMPT,
    docsContent.substring(0, 80000),
    undefined
  );

  const jsonMatch = response.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Agent did not return valid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.rules || !Array.isArray(parsed.rules)) {
    return [];
  }

  return parsed.rules.filter((r: any) =>
    r.id &&
    r.description &&
    ["nit", "general", "blocker"].includes(r.severity)
  );
}
