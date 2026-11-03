/**
 * Google Gemini adapter (Generative Language REST API, generateContent).
 * Requests JSON output constrained by the stage's JSON Schema; the caller still
 * validates the result with Zod. Set LLM_PROVIDER=gemini and LLM_API_KEY
 * (or GEMINI_API_KEY) to use it.
 */
import { z } from "zod/v4";
import { getConfig } from "@/lib/config";
import { TransientError } from "@/lib/util";
import { LLMError, type LLMProvider, type LLMRawResponse, type LLMRequest } from "./types";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; status?: string; message?: string };
}

/** Models that recently answered 503/429 are skipped for a while instead of being retried on every call. */
const COOLDOWN_MS = 5 * 60_000;
const cooldownUntil = new Map<string, number>();
export function resetGeminiCooldowns() {
  cooldownUntil.clear();
}

const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

export class GeminiLLMProvider implements LLMProvider {
  readonly name = "gemini";
  readonly dataSource = "real" as const;
  readonly model: string;
  private cfg = getConfig().llm;
  /** Some models/endpoints reject a JSON schema; after the first rejection we fall back to plain JSON mode. */
  private schemaSupported = true;

  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {
    this.model = this.cfg.model;
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse> {
    // Overloaded (503) or out-of-quota (429) models fall through to the configured fallbacks.
    const all = [this.model, ...this.cfg.fallbackModels.filter((m) => m !== this.model)];
    const now = Date.now();
    const available = all.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
    const models = available.length ? available : all; // if everything is cooling down, try them all anyway
    let res!: { status: number; json: GeminiResponse; model: string };
    for (const model of models) {
      res = await this.call(req, this.schemaSupported, model);
      if (res.status === 400 && this.schemaSupported && /schema/i.test(res.json.error?.message ?? "")) {
        this.schemaSupported = false;
        res = await this.call(req, false, model);
      }
      if (res.status !== 503 && res.status !== 429) break;
      cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
    }
    return this.parse(res);
  }

  private async call<T>(req: LLMRequest<T>, withSchema: boolean, model: string) {
    const generationConfig: Record<string, unknown> = {
      responseMimeType: "application/json",
      maxOutputTokens: req.maxTokens ?? 16000,
      temperature: 0.2,
    };
    if (withSchema) generationConfig.responseJsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    const user = withSchema ? req.user : `${req.user}\n\nReturn JSON matching this schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new TransientError(`Gemini connection error: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    return { status: res.status, json, model };
  }

  private parse({ status, json, model }: { status: number; json: GeminiResponse; model: string }): LLMRawResponse {
    const msg = json.error?.message ?? `HTTP ${status}`;
    if (status === 429) throw new TransientError(`Gemini rate limit / quota: ${msg}`, 15_000);
    if (status >= 500) throw new TransientError(`Gemini server error ${status}`);
    if (status === 401 || status === 403) throw new LLMError(`Gemini rejected the API key (${status}): ${msg}`, "config");
    if (status === 404) throw new LLMError(`Gemini model "${model}" not found — set LLM_MODEL to an available model`, "config");
    if (status >= 400) throw new LLMError(`Gemini rejected the request (${status}): ${msg}`, "api");

    const usage = {
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0),
      model: json.modelVersion ?? model,
    };
    const cand = json.candidates?.[0];
    if (json.promptFeedback?.blockReason || (cand?.finishReason && BLOCKED.has(cand.finishReason))) {
      return { ...usage, refused: true };
    }
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
    return { ...usage, text, truncated: cand?.finishReason === "MAX_TOKENS" };
  }
}
