import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { setMaxListeners } from "events";
import { debug, info, error as logError } from "./logger";

// Each ChatOpenAI invoke() registers an AbortSignal listener per HTTP request
// (including retries). With 6 parallel nodes * ~3 requests each (attempts + retries
// + tool iterations), we exceed the default 10. 50 provides comfortable headroom.
setMaxListeners(50);

interface ModelResponse {
  content: string;
}

const MAX_CONCURRENT_CALLS = 1;
const TIMEOUT = 300_000;

const modelCache = new Map<string, ChatOpenAI>();

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
  const resolvedModel = resolveModel(modelName, projectModel);
  if (!modelCache.has(resolvedModel)) {
    const { apiUrl, apiKey } = getApiConfig();
    modelCache.set(resolvedModel, new ChatOpenAI({
      modelName: resolvedModel,
      temperature: 0.1,
      timeout: TIMEOUT,
      maxRetries: 2,
      maxConcurrency: MAX_CONCURRENT_CALLS,
      configuration: {
        baseURL: apiUrl || undefined,
        apiKey,
      },
    }));
  }
  return modelCache.get(resolvedModel)!;
}

export async function callModel(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  projectModel?: string
): Promise<ModelResponse> {
  const chatModel = createChatModel(model, projectModel);
  const start = Date.now();
  debug("callModel request", { model: resolveModel(model, projectModel), promptLen: userPrompt.length, systemPrompt, userPrompt });

  try {
    const response = await chatModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const elapsed = Date.now() - start;
    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    info("callModel response", {
      elapsed,
      contentLen: content.length,
      content,
    });

    return { content };
  } catch (err) {
    const elapsed = Date.now() - start;
    logError("callModel failed", { elapsed, err: String(err) });
    throw err;
  }
}
