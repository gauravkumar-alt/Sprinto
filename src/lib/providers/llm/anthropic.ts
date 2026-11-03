/**
 * Anthropic (Claude) adapter. Uses structured outputs so the model must return
 * JSON matching the stage schema; the caller still validates it with Zod.
 * Requires a runtime API key (LLM_API_KEY / ANTHROPIC_API_KEY) — a Claude Code
 * subscription does NOT grant the deployed app API access.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getConfig } from "@/lib/config";
import { TransientError } from "@/lib/util";
import { LLMError, type LLMProvider, type LLMRawResponse, type LLMRequest } from "./types";

export class AnthropicLLMProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly dataSource = "real" as const;
  readonly model: string;
  private client: Anthropic;
  private cfg = getConfig().llm;

  constructor(apiKey: string) {
    this.model = this.cfg.model;
    this.client = new Anthropic({ apiKey, timeout: this.cfg.timeoutMs, maxRetries: 2 });
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: this.cfg.effort, format: zodOutputFormat(req.schema) },
        ...(this.cfg.refusalFallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      if (response.stop_reason === "refusal") {
        return { model: response.model, refused: true, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      }
      const text = response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return {
        text,
        model: response.model,
        truncated: response.stop_reason === "max_tokens",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new LLMError("LLM authentication failed — check LLM_API_KEY", "config");
      if (err instanceof Anthropic.PermissionDeniedError) throw new LLMError(`LLM permission denied: ${err.message}`, "config");
      if (err instanceof Anthropic.BadRequestError) throw new LLMError(`LLM rejected the request: ${err.message}`, "api");
      if (err instanceof Anthropic.RateLimitError) throw new TransientError("LLM rate limit reached", 15_000);
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new TransientError("LLM request timed out");
      if (err instanceof Anthropic.InternalServerError) throw new TransientError(`LLM server error ${err.status}`);
      if (err instanceof Anthropic.APIConnectionError) throw new TransientError("LLM connection error");
      if (err instanceof Anthropic.APIError) throw new LLMError(`LLM API error ${err.status}: ${err.message}`, "api");
      throw err;
    }
  }
}
