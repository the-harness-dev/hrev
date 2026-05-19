import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { Config } from "./types";
import { z } from "zod";

const severitySchema = z.enum(["nit", "general", "blocker"]);

const ruleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  severity: severitySchema,
  path: z.string().optional(),
  model: z.string().optional(),
});

const configSchema = z.object({
  model: z.string().optional(),
  rules: z.array(ruleSchema).min(1),
});

export function loadConfig(configPath = "hrev.yml"): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = readFileSync(configPath, "utf-8");
  const validated = configSchema.parse(parse(content) as unknown);

  return validated;
}
