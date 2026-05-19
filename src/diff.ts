import { execSync } from "child_process";
import { Diff, DiffFile } from "./types";

export function getGitDiff(base?: string, head?: string): Diff {
  const range = base ? `${base}...${head || "HEAD"}` : "HEAD";
  const raw = execSync(`git diff ${range}`, { encoding: "utf-8" });
  return parseDiff(raw);
}

const LOCKFILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /composer\.lock$/,
  /\.terraform\.lock\.hcl$/,
];

function isLockfile(path: string): boolean {
  return LOCKFILE_PATTERNS.some((p) => p.test(path));
}

export function parseDiff(raw: string): Diff {
  const files: DiffFile[] = [];
  const chunks = raw.split("diff --git ").slice(1);
  
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    // Extract file path from the +++ or --- line or the header
    const pathMatch = lines[0].match(/a\/(.+?) b\/(.+)/);
    const path = pathMatch ? pathMatch[2] : "unknown";
    files.push({ path, content: chunk });
  }
  
  const filteredFiles = files.filter((f) => !isLockfile(f.path));
  const filteredRaw = filteredFiles.length === files.length
    ? raw
    : filteredFiles.map((f) => `diff --git ${f.content}`).join("");
  
  return { files: filteredFiles, raw: filteredRaw };
}

export function diffContainsPath(diff: Diff, pathPrefix: string): boolean {
  return diff.files.some((f) => f.path.startsWith(pathPrefix));
}
