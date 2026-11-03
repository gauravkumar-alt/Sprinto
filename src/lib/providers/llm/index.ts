/**
 * runPrompt: the single gateway for every model call. It builds the prompt,
 * calls the provider, validates the JSON against the stage schema, retries a
 * bounded number of times on malformed output or transient errors, and logs
 * usage/cost. Malformed output never reaches the next stage.
 */
import type { z } from "zod/v4";
import { MODEL_PRICES_PER_MTOK, getConfig } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import { errorMessage, withRetry } from "@/lib/util";
import { LLMError, type LLMProvider, type PromptName } from "./types";

export interface PromptModule<I, T> {
  name: PromptName;
  schema: z.ZodType<T>;
  system: string;
  buildUser(input: I): string;
}

export function parseModelJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned);
}

export async function runPrompt<I, T>(
  llm: LLMProvider,
  prompt: PromptModule<I, T>,
  input: I,
  ctx: { agentRunId?: number | null } = {},
): Promise<T> {
  const cfg = getConfig().llm;
  const baseUser = prompt.buildUser(input);
  let user = baseUser;
  let lastIssue = "";
  for (let attempt = 0; attempt <= cfg.maxJsonRetries; attempt++) {
    const started = Date.now();
    let raw;
    try {
      raw = await withRetry(() => llm.complete({ task: prompt.name, system: prompt.system, user, schema: prompt.schema, input }), {
        retries: 2,
      });
    } catch (err) {
      logCall(llm, prompt.name, ctx, { ok: false, error: errorMessage(err), ms: Date.now() - started });
      if (err instanceof LLMError) throw err;
      throw new LLMError(`LLM call failed: ${errorMessage(err)}`, "api");
    }
    const usage = { in: raw.inputTokens, out: raw.outputTokens, model: raw.model };
    if (raw.refused) {
      logCall(llm, prompt.name, ctx, { ok: false, error: "refusal", ms: Date.now() - started, usage });
      throw new LLMError("The model declined this request (refusal).", "refusal");
    }
    let parsed: unknown;
    try {
      parsed = raw.object !== undefined ? raw.object : parseModelJson(raw.text ?? "");
    } catch {
      lastIssue = raw.truncated ? "output was truncated (max_tokens)" : "output was not valid JSON";
      logCall(llm, prompt.name, ctx, { ok: false, error: lastIssue, ms: Date.now() - started, usage });
      user = `${baseUser}\n\nYour previous answer was rejected: ${lastIssue}. Return only the JSON object.`;
      continue;
    }
    const result = prompt.schema.safeParse(parsed);
    if (result.success) {
      logCall(llm, prompt.name, ctx, { ok: true, ms: Date.now() - started, usage });
      return result.data;
    }
    lastIssue = result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    logCall(llm, prompt.name, ctx, { ok: false, error: `schema: ${lastIssue}`, ms: Date.now() - started, usage });
    user = `${baseUser}\n\nYour previous answer failed schema validation (${lastIssue}). Return a corrected JSON object.`;
  }
  throw new LLMError(`Model output for "${prompt.name}" stayed invalid after retries: ${lastIssue}`, "invalid_output");
}

function logCall(
  llm: LLMProvider,
  task: string,
  ctx: { agentRunId?: number | null },
  r: { ok: boolean; error?: string; ms: number; usage?: { in?: number; out?: number; model: string } },
) {
  try {
    const price = MODEL_PRICES_PER_MTOK[r.usage?.model ?? llm.model] ?? MODEL_PRICES_PER_MTOK[llm.model];
    const cost =
      price && r.usage?.in !== undefined && r.usage?.out !== undefined
        ? (r.usage.in * price.input + r.usage.out * price.output) / 1_000_000
        : null;
    getDb()
      .prepare(
        `INSERT INTO llm_calls (agent_run_id, task, provider, model, input_tokens, output_tokens, cost_usd, duration_ms, ok, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(ctx.agentRunId ?? null, task, llm.name, r.usage?.model ?? llm.model, r.usage?.in ?? null, r.usage?.out ?? null, cost, r.ms, r.ok ? 1 : 0, r.error ?? null, nowIso());
  } catch {
    /* usage logging must never break the pipeline */
  }
}
