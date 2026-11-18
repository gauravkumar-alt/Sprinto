import { describe, expect, it } from "vitest";
import { findJobBoard, hackerNewsUrls } from "@/lib/providers/research/free-sources";

const res = (status: number, body: unknown) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("free outside sources", () => {
  it("accepts a guessed job board only when a posting names the company's domain", async () => {
    const ashby = { jobs: [{ title: "Security Engineer", location: "Remote", descriptionPlain: "Join us at plane.so to build project tools." }] };
    const other = { jobs: [{ title: "Pilot", location: "NYC", descriptionPlain: "Plane is a payroll company." }] };
    const f = (body: unknown) => async (url: string) => (url.includes("ashbyhq") ? res(200, body) : res(404, ""));
    const ok = await findJobBoard("Plane", "plane.so", [], f(ashby));
    expect(ok?.url).toBe("https://jobs.ashbyhq.com/plane");
    expect(ok?.text).toContain("Security Engineer — Remote.");
    expect(await findJobBoard("Plane", "plane.so", [], f(other))).toBeNull();
  });

  it("trusts a board the company's own site links to", async () => {
    const lever = [{ text: "GRC Analyst", categories: { location: "London" }, descriptionPlain: "Help us grow." }];
    const f = async (url: string) => (url.includes("api.lever.co/v0/postings/acme-inc") ? res(200, lever) : res(404, ""));
    const b = await findJobBoard("Acme", "acme.com", ["https://jobs.lever.co/acme-inc"], f);
    expect(b?.url).toBe("https://jobs.lever.co/acme-inc");
  });

  it("Hacker News matches the name as a whole word and needs a newsworthy title", async () => {
    const hits = { hits: [
      { url: "https://news.example/a", title: "China to bar people from planes and trains" },
      { url: "https://techcrunch.com/plane-raises", title: "Plane raises $4M seed round" },
      { url: "https://blog.example/b", title: "Plane: my favourite tool" },
    ] };
    const r = await hackerNewsUrls("Plane", "plane.so", async () => res(200, hits));
    expect(r.map((x) => x.url)).toEqual(["https://techcrunch.com/plane-raises"]);
  });
});
