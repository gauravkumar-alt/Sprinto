import { describe, expect, it, vi } from "vitest";
import { GeminiSearchProvider } from "@/lib/providers/research/search";

describe("Gemini grounded search", () => {
  it("returns real source URLs (resolving Google redirects) and never the model's own text", async () => {
    const f = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("generateContent"))
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "Acme raised $500M (model wording, must be ignored)" }] },
                groundingMetadata: {
                  groundingChunks: [
                    { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "techcrunch.com" } },
                    { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "evil" } },
                    { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "dup" } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      if (u.endsWith("/abc")) return new Response(null, { status: 302, headers: { location: "https://techcrunch.com/2026/acme-series-b" } });
      if (u.endsWith("/def")) return new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } });
      throw new Error(`unexpected ${u}`);
    });
    const p = new GeminiSearchProvider("k", "gemini-x", f as unknown as typeof fetch);
    const r = await p.search("Acme funding");
    expect(r).toEqual([{ title: "techcrunch.com", url: "https://techcrunch.com/2026/acme-series-b", snippet: "", publishedAt: null }]);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
  });
});
