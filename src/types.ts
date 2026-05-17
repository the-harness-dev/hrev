export type Severity = "nit" | "general" | "blocker";

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  path?: string; // optional path constraint
  model?: string; // optional per-rule model override
}

export interface Config {
  model?: string; // optional project-level default model
  rules: Rule[];
}

export interface ReviewResult {
  ruleId: string;
  passed: boolean;
  reasoning: string;
  severity: Severity;
}

export interface ReviewSummary {
  passed: boolean;
  results: ReviewResult[];
  summary: string;
}

export interface DiffFile {
  path: string;
  content: string;
}

export interface Diff {
  files: DiffFile[];
  raw: string;
}
