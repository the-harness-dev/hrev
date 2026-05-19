import { StateGraph, Annotation } from "@langchain/langgraph";
import { callModel } from "./model";
import { DocumentedPattern, CodePattern, CodeArea } from "./types";
import { debug, info, warn, error as logError } from "./logger";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import YAML from "yaml";

interface RecommendedRule {
  id: string;
  description: string;
  severity: "nit" | "general" | "blocker";
  path?: string;
  rationale: string;
}

type RecommendStateType = typeof RecommendState.State;

interface RecWorkflowGraph {
  addNode(name: string, fn: (state: RecommendStateType) => Partial<RecommendStateType> | Promise<Partial<RecommendStateType>>): void;
  addEdge(from: string, to: string): void;
  compile(): RecCompiledGraph;
}

interface RecCompiledGraph {
  invoke(input: Partial<RecommendStateType>): Promise<RecommendStateType>;
}


const RecommendState = Annotation.Root({
  projectDir: Annotation<string>,
  docsContent: Annotation<string>,
  documentedPatterns: Annotation<DocumentedPattern[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  codeAreas: Annotation<CodeArea[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  codePatterns: Annotation<CodePattern[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  unmatchedPatterns: Annotation<CodePattern[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  rules: Annotation<RecommendedRule[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  model: Annotation<string | undefined>,
});

function findMarkdownFiles(dir: string, depth = 0): string[] {
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

function detectLanguages(projectDir: string): string[] {
  const indicators: Record<string, string> = {
    "package.json": "typescript",
    "go.mod": "go",
    "Cargo.toml": "rust",
    "requirements.txt": "python",
    "Gemfile": "ruby",
    "pom.xml": "java",
    "build.gradle": "java",
  };

  const languages: string[] = [];
  for (const [file, lang] of Object.entries(indicators)) {
    if (existsSync(join(projectDir, file))) {
      if (!languages.includes(lang)) {
        languages.push(lang);
      }
    }
  }

  if (existsSync(join(projectDir, "build.gradle.kts"))) {
    if (!languages.includes("java")) {
      languages.push("java");
    }
  }

  return languages;
}

function getFileExtension(lang: string): string {
  const map: Record<string, string> = {
    typescript: ".ts",
    javascript: ".js",
    go: ".go",
    rust: ".rs",
    python: ".py",
    ruby: ".rb",
    java: ".java",
  };
  return map[lang] || "";
}

function discoverCodeAreas(projectDir: string): CodeArea[] {
  const candidateDirs = ["src", "lib", "internal", "cmd", "pkg", "app"];
  const areas: CodeArea[] = [];
  const langList = detectLanguages(projectDir);
  const ext = langList.length > 0 ? getFileExtension(langList[0]) : ".ts";

  for (const dirName of candidateDirs) {
    const dirPath = join(projectDir, dirName);
    if (!existsSync(dirPath)) continue;

    try {
      const entries = execSync(`ls -1 "${dirPath}" 2>/dev/null || true`, { encoding: "utf-8" })
        .split("\n")
        .filter((e) => e.trim());

      if (entries.length < 3) continue;

      const sourceFiles: string[] = [];
      const excludedDirs = /node_modules|\.venv|vendor|dist|build|\.git/;

      function recurse(d: string, depth: number) {
        if (depth > 3) return;
        try {
          const items = execSync(`ls -1 "${d}" 2>/dev/null || true`, { encoding: "utf-8" })
            .split("\n")
            .filter((e) => e.trim());
          for (const item of items) {
            const itemPath = join(d, item);
            if (excludedDirs.test(item)) continue;
            if (item.includes("test") || item.includes("_test") || item.includes("spec")) continue;
            if (item.endsWith(ext) && sourceFiles.length < 5) {
              sourceFiles.push(itemPath);
            } else if (!item.includes(".")) {
              recurse(itemPath, depth + 1);
            }
          }
        } catch {
          // ignore
        }
      }

      recurse(dirPath, 0);

      if (sourceFiles.length > 0) {
        let sampleContents = "";
        for (const f of sourceFiles) {
          try {
            const content = readFileSync(f, "utf-8");
            const lines = content.split("\n").slice(0, 200).join("\n");
            sampleContents += `\n\n--- FILE: ${f} ---\n\n${lines}`;
          } catch {
            // skip unreadable files
          }
        }

        areas.push({
          name: dirName,
          language: langList[0] || "unknown",
          sampleFiles: sourceFiles,
          sampleContents: sampleContents.substring(0, 60000),
        });
      }
    } catch {
      // skip problematic directories
    }
  }

  areas.sort((a, b) => b.sampleFiles.length - a.sampleFiles.length);
  return areas.slice(0, 5);
}

function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // fall through to raw parse
    }
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  return null;
}

function resolveModel(projectDir: string): string | undefined {
  let model: string | undefined = process.env.HREV_MODEL;
  const configPath = join(projectDir, "hrev.yml");
  if (existsSync(configPath)) {
    try {
      const configContent = readFileSync(configPath, "utf-8");
      const config = YAML.parse(configContent) as { model?: string } | null;
      if (config?.model) {
        model = config.model;
      }
    } catch {
      // ignore
    }
  }
  return model;
}

const DOCS_SYSTEM_PROMPT = `You are a code review architect. Analyze the following project documentation and extract documented invariants — rules, conventions, and architectural choices that the documentation explicitly states SHOULD be followed.

For each documented pattern, provide:
- id: kebab-case identifier
- description: the invariant in plain English
- source: which document mentions this
- category: one of architecture | data | security | api | design

Focus on:
- Architecture: layer boundaries, dependency direction, module structure
- Data: ORM patterns, database access rules, validation, invariants
- Security: auth patterns, input sanitization, separation of concerns
- API: contracts, response formats, error handling patterns
- Design: patterns the project follows (repository, factory, etc.)

Return ONLY valid JSON:
{
  "patterns": [
    {
      "id": "layer-boundary",
      "description": "Services must never import from controller layer",
      "source": "docs/architecture.md",
      "category": "architecture"
    }
  ]
}`;

const CODE_ANALYSIS_PROMPT = `You are analyzing source code from area "{name}" (language: {language}) to identify enforced patterns.

The samples below are excerpts from {fileCount} files in this area. Identify patterns that the codebase consistently enforces — conventions, architectural choices, and invariants that are observable from the code itself.

For each pattern, provide:
- id: kebab-case identifier prefixed with "code-"
- description: the pattern in plain English
- category: one of architecture | data | security | api | design
- frequency: a float 0.0-1.0 (how many files enforce this relative to total)
- totalFiles: the number of sample files examined
- area: the area name
- examples: 1-3 short code excerpts (one line each) demonstrating the pattern

Return ONLY valid JSON:
{
  "patterns": []
}`;

const MATCH_SYSTEM_PROMPT = `You are matching code-observed patterns to documented patterns. Given two lists:

Documented patterns (from docs, what SHOULD be followed):
{documentedJson}

Code patterns (from source analysis, what IS followed):
{codeJson}

For each code pattern, determine if it is already covered by a documented pattern (semantically equivalent). If yes, don't include it. Only include code patterns that have NO semantic match in the documented patterns.

Return ONLY valid JSON:
{
  "unmatched": []
}`;

const RULES_SYSTEM_PROMPT = `You are a code review architect. Based on the following code patterns that are NOT documented, generate review rules that would enforce these patterns in future PRs.

For each pattern, assign severity based on frequency:
- >=0.8: blocker (near-universal — likely a hard requirement)
- >=0.5: general (majority convention)
- <0.5: nit (emerging or inconsistent)

For each rule, provide:
- id: kebab-case identifier
- description: Plain English, imperative, specific enough for an AI to evaluate
- severity: blocker | general | nit
- path: Optional directory constraint (use the pattern's area)
- rationale: Why this rule matters

Return ONLY valid JSON:
{
  "rules": []
}`;

export async function spawnSubAgent(projectDir: string): Promise<RecommendedRule[]> {
  console.log("  Scanning project for documentation files...");
  const start = Date.now();
  const markdownFiles = findMarkdownFiles(projectDir);

  let docsContent = "";
  let totalSize = 0;
  for (const file of markdownFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      if (content.length < 50000) {
        docsContent += `\n\n--- FILE: ${file} ---\n\n${content}`;
        totalSize += content.length;
      }
    } catch {
      warn("Could not read file", { file });
    }
  }

  const truncated = docsContent ? docsContent.substring(0, 80000) : "";
  const model = resolveModel(projectDir);

  if (truncated) {
    console.log(`  Found ${String(markdownFiles.length)} markdown file(s) (${String(Math.round(totalSize / 1024))} KB total).`);
  }

  const workflow = new StateGraph(RecommendState) as unknown as RecWorkflowGraph;

  workflow.addNode("docsNode", async (state: typeof RecommendState.State) => {
    if (!state.docsContent) {
      debug("Docs node: no documentation content, skipping");
      return { documentedPatterns: [] };
    }

    try {
      debug("Docs node: analyzing documentation", { contentLen: state.docsContent.length });
      const response = await callModel(DOCS_SYSTEM_PROMPT, state.docsContent, undefined, state.model);
      const parsed = parseJsonResponse(response.content);
      const patterns = parsed && typeof parsed === "object" && "patterns" in parsed ? (parsed as Record<string, unknown>).patterns as unknown[] : null;

      if (Array.isArray(patterns)) {
        debug("Docs node: patterns extracted", { count: patterns.length });
        return { documentedPatterns: patterns as DocumentedPattern[] };
      }

      warn("Docs node: unexpected response format");
      return { documentedPatterns: [] };
    } catch (err) {
      logError("Docs node: AI call failed", { err: String(err) });
      return { documentedPatterns: [] };
    }
  });

  workflow.addNode("codeDiscoveryNode", (state: typeof RecommendState.State) => {
    try {
      debug("Code discovery: scanning areas", { projectDir: state.projectDir });
      const areas = discoverCodeAreas(state.projectDir);
      debug("Code discovery: areas found", { count: areas.length });
      return { codeAreas: areas };
    } catch (err) {
      logError("Code discovery: failed", { err: String(err) });
      return { codeAreas: [] };
    }
  });

  workflow.addNode("codeAnalysisNode", async (state: typeof RecommendState.State) => {
    info("Code analysis: entered", { areaCount: state.codeAreas.length });

    if (state.codeAreas.length === 0) {
      debug("Code analysis: no code areas to analyze");
      return { codePatterns: [] };
    }

    try {
      const results = await Promise.all(
        state.codeAreas.map(async (area) => {
          const prompt = CODE_ANALYSIS_PROMPT
            .replace("{name}", area.name)
            .replace("{language}", area.language)
            .replace("{fileCount}", String(area.sampleFiles.length));

          try {
            const response = await callModel(prompt, area.sampleContents, undefined, state.model);
            const parsed = parseJsonResponse(response.content);
            const patterns = parsed && typeof parsed === "object" && "patterns" in parsed ? (parsed as Record<string, unknown>).patterns as unknown[] : null;

            if (Array.isArray(patterns)) {
              return patterns.map((p: unknown) => ({
                ...(p as Record<string, unknown>),
                totalFiles: area.sampleFiles.length,
                area: area.name,
              }));
            }

            warn("Code analysis: unexpected format for area", { area: area.name });
            return [];
          } catch (err) {
            logError("Code analysis: AI call failed for area", { area: area.name, err: String(err) });
            return [];
          }
        })
      );

      const allPatterns = results.flat() as CodePattern[];
      debug("Code analysis: patterns found", { count: allPatterns.length });
      return { codePatterns: allPatterns };
    } catch (err) {
      logError("Code analysis: failed", { err: String(err) });
      return { codePatterns: [] };
    }
  });

  workflow.addNode("matchNode", async (state: typeof RecommendState.State) => {
    info("Match node: entered", { codePatterns: state.codePatterns.length, documentedPatterns: state.documentedPatterns.length });

    if (state.codePatterns.length === 0) {
      debug("Match node: no code patterns to match, returning all as unmatched");
      return { unmatchedPatterns: state.codePatterns };
    }

    if (state.documentedPatterns.length === 0) {
      debug("Match node: no documented patterns, all code patterns are unmatched");
      return { unmatchedPatterns: state.codePatterns };
    }

    try {
      const prompt = MATCH_SYSTEM_PROMPT
        .replace("{documentedJson}", JSON.stringify(state.documentedPatterns))
        .replace("{codeJson}", JSON.stringify(state.codePatterns));

      debug("Match node: sending patterns for matching", {
        codePatterns: state.codePatterns.length,
        documentedPatterns: state.documentedPatterns.length,
      });

      const response = await callModel(prompt, "", undefined, state.model);
      const parsed = parseJsonResponse(response.content);
      const unmatched = parsed && typeof parsed === "object" && "unmatched" in parsed ? (parsed as Record<string, unknown>).unmatched as unknown[] : [];

      if (Array.isArray(unmatched)) {
        debug("Match node: results", { unmatchedCount: unmatched.length, codePatterns: state.codePatterns.length, documentedPatterns: state.documentedPatterns.length });
        return { unmatchedPatterns: unmatched as CodePattern[] };
      }

      warn("Match node: unexpected response, treating all as unmatched");
      return { unmatchedPatterns: state.codePatterns };
    } catch (err) {
      logError("Match node: AI call failed", { err: String(err) });
      return { unmatchedPatterns: state.codePatterns };
    }
  });

  workflow.addNode("generateRulesNode", async (state: typeof RecommendState.State) => {
    if (state.unmatchedPatterns.length === 0) {
      debug("Generate rules: no unmatched patterns, skipping");
      return { rules: [] };
    }

    try {
      const userPrompt = JSON.stringify(state.unmatchedPatterns);
      debug("Generate rules: generating rules from patterns", { count: state.unmatchedPatterns.length });

      const response = await callModel(RULES_SYSTEM_PROMPT, userPrompt, undefined, state.model);
      const parsed = parseJsonResponse(response.content);
      const rules = parsed && typeof parsed === "object" && "rules" in parsed ? (parsed as Record<string, unknown>).rules as unknown[] : null;

      if (Array.isArray(rules)) {
        const validRules = rules.filter(
          (r) => {
            const o = r as Record<string, unknown>;
            return o.id && o.description && typeof o.severity === "string" && ["nit", "general", "blocker"].includes(o.severity);
          }
        ) as RecommendedRule[];
        debug("Generate rules: rules created", { total: rules.length, valid: validRules.length });
        return { rules: validRules };
      }

      warn("Generate rules: unexpected response format");
      return { rules: [] };
    } catch (err) {
      logError("Generate rules: AI call failed", { err: String(err) });
      return { rules: [] };
    }
  });

  workflow.addEdge("__start__", "docsNode");
  workflow.addEdge("__start__", "codeDiscoveryNode");
  workflow.addEdge("codeDiscoveryNode", "codeAnalysisNode");
  workflow.addEdge("docsNode", "matchNode");
  workflow.addEdge("codeAnalysisNode", "matchNode");
  workflow.addEdge("matchNode", "generateRulesNode");
  workflow.addEdge("generateRulesNode", "__end__");

  const graph = workflow.compile();

  const result = await graph.invoke({
    projectDir,
    docsContent: truncated,
    documentedPatterns: [],
    codeAreas: [],
    codePatterns: [],
    unmatchedPatterns: [],
    rules: [],
    model,
  });

  const elapsed = Date.now() - start;
  info("Recommendation flow complete", { elapsed, rules: result.rules.length });

  return result.rules;
}
