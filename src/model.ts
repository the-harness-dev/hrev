interface ModelResponse {
  content: string;
}

export async function callModel(
  systemPrompt: string,
  userPrompt: string,
  model?: string
): Promise<ModelResponse> {
  const apiUrl = process.env.HREV_API_URL;
  const apiKey = process.env.HREV_API_KEY;

  if (!apiKey) {
    throw new Error("HREV_API_KEY environment variable is required");
  }

  const resolvedModel = model || process.env.HREV_MODEL;
  if (!resolvedModel) {
    throw new Error(
      "No model specified. Set 'model' in hrev.yml (project or rule level) or set HREV_MODEL environment variable."
    );
  }

  const url = apiUrl ? `${apiUrl.replace(/\/$/, "")}/chat/completions` : "https://api.openai.com/v1/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Model API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";

  return { content };
}
