import { debug, info, error as logError } from "./logger";

const MAX_CONCURRENT_CALLS = 8;

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      next?.();
    }
  }
}

const modelSemaphore = new Semaphore(MAX_CONCURRENT_CALLS);

interface ModelResponse {
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function callModel(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  projectModel?: string
): Promise<ModelResponse> {
  const apiUrl = process.env.HREV_API_URL;
  const apiKey = process.env.HREV_API_KEY;

  if (!apiKey) {
    logError("HREV_API_KEY not set");
    throw new Error("HREV_API_KEY environment variable is required");
  }

  const resolvedModel = model || projectModel || process.env.HREV_MODEL;
  if (!resolvedModel) {
    logError("No model resolved");
    throw new Error(
      "No model specified. Priority: rule-level model > project-level model > HREV_MODEL env variable."
    );
  }

  const url = apiUrl ? `${apiUrl.replace(/\/$/, "")}/chat/completions` : "https://api.openai.com/v1/chat/completions";

  const body = JSON.stringify({
    model: resolvedModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const start = Date.now();
  debug("callModel request", { url, model: resolvedModel, promptLen: userPrompt.length, systemPrompt, userPrompt });

  return modelSemaphore.run(async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const elapsed = Date.now() - start;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        logError("callModel timed out", { elapsed, timeout: 120_000 });
        throw new Error(`Model API timed out after 120s (${url})`, { cause: err });
      }
      logError("callModel fetch failed", { elapsed, err: String(err) });
      throw new Error(String(err), { cause: err });
    }

    const elapsed = Date.now() - start;

    if (!response.ok) {
      const errorBody = await response.text();
      logError("callModel API error", { status: response.status, elapsed, errorBody: errorBody.substring(0, 1000) });
      throw new Error(`Model API error (${String(response.status)}): ${errorBody}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage;
    info("callModel response", {
      status: response.status,
      elapsed,
      contentLen: content.length,
      content,
      ...(usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } : {}),
    });

    return { content };
  });
}
