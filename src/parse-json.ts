/**
 * Extract a JSON object from model response text.
 * Handles markdown code blocks, raw JSON, and loose object matching.
 */
export function parseJsonFromContent(content: string): unknown {
  const trimmed = content.trim();

  // Try direct parse first — model may return clean JSON with no markdown
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through
  }

  // Try ```json ... ``` or ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Fall through
    }
  }

  // Scan for balanced { ... } blocks and return the first one that JSON.parse accepts.
  // Handles nested braces in reasoning text (e.g. regex examples like /\{[\s\S]*\}/).
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") {
      let depth = 1;
      for (let j = i + 1; j < trimmed.length; j++) {
        if (trimmed[j] === "{") depth++;
        if (trimmed[j] === "}") depth--;
        if (depth === 0) {
          const candidate = trimmed.substring(i, j + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // Not valid JSON, keep scanning for next balanced block
          }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Parse a verdict from model response text.
 * Returns null if content is empty or contains no valid verdict JSON.
 * Handles string coercion for `passed` field (e.g. "false" → false).
 */
export function parseVerdictFromContent(content: string): { passed: boolean; reasoning: string } | null {
  if (!content.trim()) return null;

  const parsed = parseJsonFromContent(content);
  if (!parsed || typeof parsed !== "object") return null;

  const raw = parsed as { passed: unknown; reasoning: unknown };

  // Handle boolean, string, or any other type for `passed`
  let passed: boolean;
  if (typeof raw.passed === "boolean") {
    passed = raw.passed;
  } else if (typeof raw.passed === "string") {
    passed = raw.passed.toLowerCase() === "true";
  } else if (typeof raw.passed === "number") {
    passed = raw.passed !== 0;
  } else {
    return null; // Cannot determine pass/fail
  }

  const reasoning =
    typeof raw.reasoning === "string" && raw.reasoning.trim()
      ? raw.reasoning
      : "No reasoning provided";

  return { passed, reasoning };
}
