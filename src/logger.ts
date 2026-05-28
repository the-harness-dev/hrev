import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const LOG_DIR = "/tmp/hrev-logs";

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFileName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `hrev-${String(y)}-${m}-${d}.log`;
}

let logPath: string | null = null;

export function getLogPath(): string {
  if (!logPath) {
    ensureLogDir();
    logPath = join(LOG_DIR, getLogFileName());
  }
  return logPath;
}

function writeLog(level: string, message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const pid = process.pid;
  let line = `[${ts}] [${String(pid)}] [${level}] ${message}`;
  if (data) {
    line += ` ${JSON.stringify(data)}`;
  }
  line += "\n";

  // Print to stderr so CI captures it without interfering with --json
  process.stderr.write(line);

  // Also persist to log file
  try {
    const path = getLogPath();
    appendFileSync(path, line, "utf-8");
  } catch {
    // silently fail — don't break the app for logging failures
  }
}

export function debug(message: string, data?: Record<string, unknown>): void {
  writeLog("DEBUG", message, data);
}

export function info(message: string, data?: Record<string, unknown>): void {
  writeLog("INFO", message, data);
}

export function warn(message: string, data?: Record<string, unknown>): void {
  writeLog("WARN", message, data);
}

export function error(message: string, data?: Record<string, unknown>): void {
  writeLog("ERROR", message, data);
}
