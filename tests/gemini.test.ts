import { beforeEach, describe, expect, it } from "vitest";
import { contactSelectionPrompt } from "@/lib/prompts";
import { runPrompt } from "@/lib/providers/llm";
import { GeminiLLMProvider, resetGeminiCooldowns } from "@/lib/providers/llm/gemini";
import { LLMError } from "@/lib/providers/llm/types";
import { freshDb } from "./helpers";

const input = { titles: [{ index: 0, title: "Head of Security", department: "it" }] };
const ok = { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"classifications":[{"index":0,"category":"head_of_security","note":"x"}]}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };

function fake(responses: { status: number; body: unknown }[]) {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, urls, bodies };
}

describe("Gemini provider", () => {
  beforeEach(() => {
    freshDb();
    resetGeminiCooldowns();
    process.env.LLM_PROVIDER = "gemini";
    process.env.LLM_MODEL = "primary-model";
    process.env.LLM_FALLBACK_MODELS = "fallback-a,fallback-b";
  });

  it("sends system prompt + JSON schema and parses non-thought text", async () => {
    const { f, bodies } = fake([{ status: 200, body: ok }]);
    const out = await runPrompt(new GeminiLLMProvider("k", f), contactSelectionPrompt, input);
    expect(out.classifications[0].category).toBe("head_of_security");
    const b = bodies[0] as { systemInstruction: unknown; generationConfig: { responseMimeType: string; responseJsonSchema: unknown } };
    expect(b.generationConfig.responseMimeType).toBe("application/json");
    expect(b.generationConfig.responseJsonSchema).toBeTruthy();
    expect(b.systemInstruction).toBeTruthy();
  });

  it("falls back to the next model when the primary is overloaded", async () => {
    const { f, urls } = fake([
      { status: 503, body: { error: { message: "high demand" } } },
      { status: 429, body: { error: { message: "quota" } } },
      { status: 200, body: ok },
    ]);
    await runPrompt(new GeminiLLMProvider("k", f), contactSelectionPrompt, input);
    expect(urls.map((u) => u.match(/models\/([^:]+)/)![1])).toEqual(["primary-model", "fallback-a", "fallback-b"]);
    // next call skips the two models that are cooling down
    const next = fake([{ status: 200, body: ok }]);
    await runPrompt(new GeminiLLMProvider("k", next.f), contactSelectionPrompt, input);
    expect(next.urls.map((u) => u.match(/models\/([^:]+)/)![1])).toEqual(["fallback-b"]);
  });

  it("maps safety blocks to refusals and bad keys to config errors", async () => {
    const blocked = fake([{ status: 200, body: { candidates: [{ finishReason: "SAFETY" }] } }]);
    await expect(runPrompt(new GeminiLLMProvider("k", blocked.f), contactSelectionPrompt, input)).rejects.toMatchObject({ kind: "refusal" });
    const bad = fake([{ status: 403, body: { error: { message: "API key not valid" } } }]);
    const err = await runPrompt(new GeminiLLMProvider("k", bad.f), contactSelectionPrompt, input).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("config");
  });
});
