import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { debug, info, error as logError } from "./logger";

interface ModelResponse {
  content: string;
}

const MAX_CONCURRENT_CALLS = 3;
const TIMEOUT = 300_000;

/** Simple async semaphore to enforce a global concurrency limit across all model calls. */
class Semaphore {
  private queue: Array<() => void> = [];
  private count: number;

  constructor(private max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.count++;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.count--;
      next?.();
    }
  }
}

const modelSemaphore = new Semaphore(MAX_CONCURRENT_CALLS);

function resolveModel(model?: string, projectModel?: string): string {
  const resolved = model || projectModel || process.env.HREV_MODEL;
  if (!resolved) {
    throw new Error(
      "No model specified. Priority: rule-level model > project-level model > HREV_MODEL env variable."
    );
  }
  return resolved;
}

function getApiConfig() {
  const apiUrl = process.env.HREV_API_URL;
  const apiKey = process.env.HREV_API_KEY;

  if (!apiKey) {
    throw new Error("HREV_API_KEY environment variable is required");
  }

  return { apiUrl, apiKey };
}

export function createChatModel(modelName?: string, projectModel?: string): ChatOpenAI {
  const { apiUrl, apiKey } = getApiConfig();
  const resolvedModel = resolveModel(modelName, projectModel);

  return new ChatOpenAI({
    modelName: resolvedModel,
    temperature: 0.1,
    timeout: TIMEOUT,
    configuration: {
      baseURL: apiUrl || undefined,
      apiKey,
    },
  });
}

/**
 * Invoke the model with a full conversation history (array of BaseMessages).
 * This is the canonical entrypoint for multi-turn tool-call loops.
 * Retries automatically on empty responses (up to 2 attempts with exponential backoff).
 */
export async function callModelWithMessages(
  messages: BaseMessage[],
  model?: string,
  projectModel?: string
): Promise<ModelResponse> {
  const modelName = resolveModel(model, projectModel);
  const lastUserMsg = messages.filter((m) => m.getType() === "human").pop();
  // Serialize messages for logging (JSON-safe)
  const messagesForLog = messages.map((m) => ({
    type: m.getType(),
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));
  debug("callModelWithMessages request", {
    model: modelName,
    messageCount: messages.length,
    lastUserLen: lastUserMsg ? (lastUserMsg.content as string).length : 0,
    messages: messagesForLog,
  });

  const maxAttempts = 3;
  const baseDelay = 2000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chatModel = createChatModel(model, projectModel);
    const start = Date.now();

    await modelSemaphore.acquire();
    try {
      const response = await chatModel.invoke(messages);

      const elapsed = Date.now() - start;
      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      info("callModelWithMessages response", {
        attempt,
        elapsed,
        contentLen: content.length,
        content,
      });

      if (content.trim().length > 0) {
        return { content };
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      lastError = err instanceof Error ? err : new Error(String(err));
      logError("callModelWithMessages failed", {
        attempt,
        elapsed,
        err: String(err),
      });
    } finally {
      modelSemaphore.release();
    }

    // Retry with exponential backoff OUTSIDE the semaphore
    if (attempt < maxAttempts) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      debug("callModelWithMessages empty/error response, retrying", {
        attempt,
        delay,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All attempts exhausted; throw the last error or a clear exhaustion message
  throw (
    lastError || new Error("callModelWithMessages: all attempts returned empty")
  );
}

/**
 * Legacy convenience wrapper for single-turn calls.
 * Prefer callModelWithMessages for conversation history.
 */
export async function callModel(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  projectModel?: string
): Promise<ModelResponse> {
  return callModelWithMessages([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ], model, projectModel);
}
