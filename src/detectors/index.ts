import { Detector, Rule, DiffFile } from "../types";
import { ciGamingDetector } from "./ci-gaming";
import { codeReuseBlindnessDetector } from "./code-reuse-blindness";
import { hallucinatedCorrectnessDetector } from "./hallucinated-correctness";
import { agenticGhostingDetector } from "./agentic-ghosting";
import { promptInjectionDetector } from "./prompt-injection";

const ALL_DETECTORS: Detector[] = [
  ciGamingDetector,
  codeReuseBlindnessDetector,
  hallucinatedCorrectnessDetector,
  agenticGhostingDetector,
  promptInjectionDetector,
];

const DETECTOR_IDS = new Set(ALL_DETECTORS.map((d) => d.id));

export function getDetectors(): Detector[] {
  return ALL_DETECTORS;
}

export function isDetectorRuleId(id: string): boolean {
  return DETECTOR_IDS.has(id);
}

export function detectorToRule(detector: Detector): Rule {
  return {
    id: detector.id,
    description: detector.description,
    severity: detector.severity,
    path: detector.path,
  };
}

export function shouldRunDetector(detector: Detector, files: DiffFile[]): boolean {
  if (!detector.path) {
    return true;
  }
  const pathPrefixes = detector.path.split(",").map((p) => p.trim());
  return files.some((f) =>
    pathPrefixes.some((prefix) => f.path.startsWith(prefix))
  );
}

export function getDetectorSystemPrompt(detector: Detector): string {
  return detector.systemPrompt;
}
