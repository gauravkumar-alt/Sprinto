import type { z } from "zod/v4";
import type { DataSource } from "@/lib/schemas";

export type PromptName =
  | "research"
  | "extraction"
  | "qualification"
  | "missing_information"
  | "contact_selection"
  | "pain_points"
  | "email_generation"
  | "email_validation";

export interface LLMRequest<T> {
  task: PromptName;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Structured input the prompt was built from (used by the mock provider; never sent anywhere else). */
  input: unknown;
  maxTokens?: number;
}

export interface LLMRawResponse {
  /** Raw JSON text from a real model, or an already-built object from the mock. */
  text?: string;
  object?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
  refused?: boolean;
  truncated?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly dataSource: DataSource;
  complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse>;
}

export class LLMError extends Error {
  constructor(message: string, readonly kind: "invalid_output" | "refusal" | "api" | "rate_limit" | "timeout" | "config") {
    super(message);
    this.name = "LLMError";
  }
}
