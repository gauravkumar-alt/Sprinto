import { beforeEach, describe, expect, it } from "vitest";
import { contactSelectionPrompt } from "@/lib/prompts";
import { runPrompt } from "@/lib/providers/llm";
import { FallbackLLMProvider } from "@/lib/providers/llm/fallback";
import { GeminiLLMProvider, resetGeminiCooldowns } from "@/lib/providers/llm/gemini";
import { LLMError, type LLMProvider, type LLMRawResponse } from "@/lib/providers/llm/types";
import { TransientError } from "@/lib/util";
import { freshDb } from "./helpers";

const input = { titles: [{ index: 0, title: "Head of Security", department: "it" }] };
const good = '{"classifications":[{"index":0,"category":"head_of_security","note":"x"}]}';

function stub(name: string, behave: () => LLMRawResponse | Promise<LLMRawResponse>) {
  const calls = { n: 0 };
  const p: LLMProvider = {
    name,
    model: `${name}-model`,
    dataSource: "real",
    complete: async () => {
      calls.n++;
      return behave();
    },
  };
  return { p, calls };
}

describe("backup model", () => {
  beforeEach(() => {
    freshDb();
    resetGeminiCooldowns();
    process.env.LLM_PROVIDER = "gemini";
    process.env.LLM_MODEL = "primary-model";
    process.env.LLM_FALLBACK_MODELS = "";
  });

  it("uses the primary when it works", async () => {
    const primary = stub("gemini", () => ({ text: good, model: "gemini-model" }));
    const backup = stub("anthropic", () => ({ text: good, model: "claude" }));
    await runPrompt(new FallbackLLMProvider(primary.p, backup.p), contactSelectionPrompt, input);
    expect(primary.calls.n).toBe(1);
    expect(backup.calls.n).toBe(0);
  });

  it("hands the request to the backup when the primary is out of quota", async () => {
    const primary = stub("gemini", () => {
      throw new TransientError("Gemini rate limit / quota");
    });
    const backup = stub("anthropic", () => ({ text: good, model: "claude-opus-5-5" }));
    const out = await runPrompt(new FallbackLLMProvider(primary.p, backup.p), contactSelectionPrompt, input);
    expect(out.classifications[0].category).toBe("head_of_security");
    expect(backup.calls.n).toBe(1);
  });

  it("hands over when the primary declines, and reports both failures", async () => {
    const primary = stub("gemini", () => ({ refused: true, model: "gemini-model" }));
    const backup = stub("anthropic", () => ({ text: good, model: "claude" }));
    await runPrompt(new FallbackLLMProvider(primary.p, backup.p), contactSelectionPrompt, input);
    expect(backup.calls.n).toBe(1);

    const down = stub("gemini", () => {
      throw new TransientError("overloaded");
    });
    const alsoDown = stub("anthropic", () => {
      throw new LLMError("bad key", "config");
    });
    await expect(new FallbackLLMProvider(down.p, alsoDown.p).complete({ task: "contact_selection", system: "", user: "", schema: contactSelectionPrompt.schema, input })).rejects.toThrow(/overloaded.*bad key/);
  });

  it("a Gemini primary with a backup fails fast while every model is cooling down", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
    }) as unknown as typeof fetch;
    const g = new GeminiLLMProvider("k", f, [], { failFast: true });
    await expect(g.complete({ task: "contact_selection", system: "", user: "", schema: contactSelectionPrompt.schema, input })).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(g.complete({ task: "contact_selection", system: "", user: "", schema: contactSelectionPrompt.schema, input })).rejects.toThrow(/cooling|quota or overloaded/);
    expect(calls).toBe(1); // no second request while the model is cooling down
  });
});
