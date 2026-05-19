import { readFileSync, readdirSync } from "fs";
import { join, resolve, relative } from "path";
import { globSync } from "glob";

/**
 * Read-only workspace exploration tools for review agents.
 * Agents use these to understand context around diffs.
 */

export interface WorkspaceContext {
  root: string;
}

/**
 * Read a file's contents.
 * Returns null if file doesn't exist or is outside workspace.
 */
export function readFile(ctx: WorkspaceContext, filePath: string): string | null {
  try {
    const absolute = resolve(ctx.root, filePath);
    // Security: prevent escaping workspace
    if (!absolute.startsWith(resolve(ctx.root))) {
      return null;
    }
    return readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List files in a directory (like `ls`).
 * Returns empty array if path is invalid or outside workspace.
 */
export function listFiles(ctx: WorkspaceContext, dirPath: string = "."): string[] {
  try {
    const absolute = resolve(ctx.root, dirPath);
    if (!absolute.startsWith(resolve(ctx.root))) {
      return [];
    }
    const entries = readdirSync(absolute, { withFileTypes: true });
    return entries.map((e) => {
      const prefix = e.isDirectory() ? "📁" : "📄";
      return `${prefix} ${e.name}`;
    });
  } catch {
    return [];
  }
}

/**
 * Search files matching a glob pattern.
 */
export function globFiles(ctx: WorkspaceContext, pattern: string): string[] {
  try {
    const absolutePattern = join(ctx.root, pattern);
    const matches: string[] = globSync(absolutePattern, { cwd: ctx.root });
    return matches.map((m: string) => relative(ctx.root, m));
  } catch {
    return [];
  }
}

/**
 * Search file contents for a regex or string.
 * Returns matching files with line numbers.
 */
export function searchFiles(
  ctx: WorkspaceContext,
  query: string | RegExp,
  maxResults: number = 20
): Array<{ file: string; line: number; text: string }> {
  const results: Array<{ file: string; line: number; text: string }> = [];
  try {
    // Use glob to find files, then grep
    const files: string[] = globSync("**/*", {
      cwd: ctx.root,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.venv/**",
        "**/vendor/**",
        "**/dist/**",
        "**/build/**",
        "**/*.lock",
        "**/*.min.js",
        "**/*.min.css",
      ],
    });

    const regex = typeof query === "string" ? new RegExp(query, "i") : query;

    for (const file of files.slice(0, 500)) {
      if (results.length >= maxResults) break;

      try {
        const content = readFileSync(join(ctx.root, file), "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file,
              line: i + 1,
              text: lines[i].trim().substring(0, 120),
            });
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        // skip binary or unreadable files
      }
    }
  } catch {
    // ignore errors
  }

  return results;
}

/**
 * Get the workspace root context for a review.
 */
export function createWorkspaceContext(workspaceRoot: string): WorkspaceContext {
  return { root: resolve(workspaceRoot) };
}

/**
 * Format workspace tools for inclusion in the system prompt.
 */
export function getWorkspaceToolsDescription(): string {
  return `
You have read-only access to the workspace. Use these tools to explore context around the diff:

- readFile("path/to/file") — Read file contents (relative to workspace root)
- listFiles("path/to/dir") — List files in a directory
- globFiles("src/**/*.go") — Find files matching a glob pattern
- searchFiles("someFunctionName") — Search file contents (case-insensitive, returns file + line + match)

To use a tool, respond with:
TOOL: readFile("src/main.go")

Then I'll return the file contents and you can continue analyzing.

Use these tools sparingly — only when the diff alone doesn't provide enough context to evaluate the rule. Good reasons to explore:
- The diff calls a function you don't see defined in the diff
- The rule references a pattern or convention that might be in other files
- You need to verify if a changed function is used elsewhere
- You want to check if there's an existing test for the changed code
`;
}
