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
  description?: string; // Optional description of the change (e.g., PR title/body)
}

export type PatternCategory = "architecture" | "data" | "security" | "api" | "design";

export interface DocumentedPattern {
  id: string;
  description: string;
  source: string;
  category: PatternCategory;
}

export interface CodePattern {
  id: string;
  description: string;
  category: PatternCategory;
  frequency: number;
  totalFiles: number;
  area: string;
  examples: string[];
}

export interface CodeArea {
  name: string;
  language: string;
  sampleFiles: string[];
  sampleContents: string;
}

export interface PatternMatch {
  codePattern: CodePattern;
  documentedPattern: DocumentedPattern;
  similarityReasoning: string;
}
