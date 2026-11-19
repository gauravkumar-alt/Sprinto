/**
 * Primary model with a backup provider. When the primary fails for any reason (out of quota,
 * overloaded, timed out, key rejected) or declines the request, the same request goes to the backup.
 * The response carries the model that actually answered, so usage logs show which one was used.
 */
import { errorMessage } from "@/lib/util";
import { LLMError, type LLMProvider, type LLMRawResponse, type LLMRequest } from "./types";

export class FallbackLLMProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly dataSource = "real" as const;

  constructor(
    private primary: LLMProvider,
    private backup: LLMProvider,
  ) {
    this.name = `${primary.name}+${backup.name}`;
    this.model = primary.model;
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse> {
    let reason: string;
    try {
      const res = await this.primary.complete(req);
      if (!res.refused) return res;
      reason = "declined the request";
    } catch (err) {
      reason = errorMessage(err);
    }
    try {
      return await this.backup.complete(req);
    } catch (err) {
      const kind = err instanceof LLMError ? err.kind : "api";
      throw new LLMError(`Primary model failed (${reason}); backup ${this.backup.model} failed too: ${errorMessage(err)}`, kind);
    }
  }
}
