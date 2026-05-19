import { execSync } from "child_process";
import { Diff, DiffFile } from "./types";

export function getGitDiff(base?: string, head?: string): Diff {
  const range = base ? `${base}...${head || "HEAD"}` : "HEAD";
  const raw = execSync(`git diff ${range}`, { encoding: "utf-8" });
  return parseDiff(raw);
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
  
  return { files, raw };
}

export function diffContainsPath(diff: Diff, pathPrefix: string): boolean {
  return diff.files.some((f) => f.path.startsWith(pathPrefix));
}
