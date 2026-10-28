import { env } from "../../config/env";
import { ServiceUnavailableError } from "../../helpers/errors";

// ---------------------------------------------------------------------------
// One tiny, provider-agnostic way to ask a model for JSON. No SDKs: plain fetch,
// so switching OpenAI <-> Claude <-> Ollama is one env change.
// AI is only used for drafting (rules, agent plans). It never decides whether an
// action is allowed — that is the policy engine's job.
// ---------------------------------------------------------------------------

export interface JsonPrompt {
  system: string;
  user: string;
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
  ollama: "llama3.1",
};

const TIMEOUT_MS = 45_000;

export function isLlmConfigured(): boolean {
  if (env.LLM_PROVIDER === "none") return false;
  if (env.LLM_PROVIDER === "ollama") return true;
  return Boolean(env.LLM_API_KEY);
}

export function llmDescription() {
  return {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER] || "",
    configured: isLlmConfigured(),
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Do not pass the provider's error body on: it can echo the prompt.
      throw new ServiceUnavailableError(`The AI service answered with status ${response.status}. Please try again.`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError("Could not reach the AI service. Check LLM settings and try again.");
  } finally {
    clearTimeout(timer);
  }
}

// Models sometimes wrap JSON in prose or code fences; keep only the object.
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ServiceUnavailableError("The AI did not return a usable answer.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ServiceUnavailableError("The AI returned an answer we could not read. Please try again.");
  }
}

export async function completeJson(prompt: JsonPrompt): Promise<unknown> {
  if (!isLlmConfigured()) {
    throw new ServiceUnavailableError("AI is not set up. Set LLM_PROVIDER (and LLM_API_KEY) in server/env/local.env.");
  }
  const model = env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER];

  if (env.LLM_PROVIDER === "openai") {
    const baseUrl = env.LLM_BASE_URL || "https://api.openai.com/v1";
    const data = await postJson(
      `${baseUrl}/chat/completions`,
      { authorization: `Bearer ${env.LLM_API_KEY}` },
      {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }
    );
    return extractJsonObject(String(data?.choices?.[0]?.message?.content || ""));
  }

  if (env.LLM_PROVIDER === "anthropic") {
    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": env.LLM_API_KEY, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: 1500,
        temperature: 0,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }
    );
    const text = (data?.content || []).map((part: { text?: string }) => part.text || "").join("");
    return extractJsonObject(text);
  }

  // ollama
  const baseUrl = env.LLM_BASE_URL || "http://127.0.0.1:11434";
  const data = await postJson(
    `${baseUrl}/api/chat`,
    {},
    {
      model,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }
  );
  return extractJsonObject(String(data?.message?.content || ""));
}
