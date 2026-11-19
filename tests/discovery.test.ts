import { beforeEach, describe, expect, it } from "vitest";
import { discoveryStatus, judgePages, pickCandidates, startDiscovery, type YcCompany } from "@/lib/discovery";
import type { FetchedPage, ResearchProvider } from "@/lib/providers/research/types";
import { freshDb } from "./helpers";

const yc = (o: Partial<YcCompany>): YcCompany => ({
  name: "Acme",
  website: "https://acme.io",
  industry: "B2B",
  subindustry: "B2B -> Security",
  tags: ["SaaS", "B2B"],
  status: "Active",
  nonprofit: false,
  team_size: 40,
  batch: "W24",
  one_liner: "x",
  launched_at: 1,
  ...o,
});
const page = (url: string, text: string): FetchedPage => ({ url, title: "", text, publishedAt: null, retrievedAt: "", sourceType: "website" });

describe("discovery: candidate filter", () => {
  it("keeps active B2B/SaaS companies of 15–300 people and skips known domains", () => {
    const list = [
      yc({ name: "Fit", website: "https://www.fit.io/" }),
      yc({ name: "Tiny", website: "https://tiny.io", team_size: 5 }),
      yc({ name: "Huge", website: "https://huge.io", team_size: 2000 }),
      yc({ name: "Consumer", website: "https://c.io", industry: "Consumer" }),
      yc({ name: "Dead", website: "https://dead.io", status: "Inactive" }),
      yc({ name: "Known", website: "https://known.io" }),
      yc({ name: "Fintech SaaS", website: "https://pay.io", industry: "Fintech", subindustry: "Fintech -> Payments" }),
      yc({ name: "Fintech consumer", website: "https://bank.io", industry: "Fintech", tags: ["Consumer"] }),
      yc({ name: "Rival", website: "https://rival.io", one_liner: "SOC 2 compliance automation for startups" }),
      yc({ name: "Agency", website: "https://getagency.com", one_liner: "Replaces security and compliance headcount with AI.", tags: ["SaaS", "B2B", "Compliance"] }),
    ];
    const out = pickCandidates(list, new Set(["known.io"]), 10);
    expect(out.map((c) => c.domain).sort()).toEqual(["fit.io", "pay.io"]);
  });
});

describe("discovery: website check", () => {
  it("sets aside companies that show a certification", () => {
    expect(judgePages([page("https://a.io/", "We are SOC 2 Type II compliant.")], "a.io").verdict).toBe("certified");
    expect(judgePages([page("https://a.io/security", "SOC 2 Type II\nISO 27001")], "a.io").verdict).toBe("certified");
    expect(judgePages([page("https://a.io/", "Visit our Trust Center.")], "a.io").verdict).toBe("certified");
  });

  it("flags companies working toward a certification as the strongest fit", () => {
    const r = judgePages([page("https://a.io/security", "We are currently preparing for our SOC 2 Type II audit.")], "a.io");
    expect(r.verdict).toBe("preparing");
    expect(r.quote).toMatch(/preparing/);
  });

  it("suggests companies with no certification, and ignores blog posts and customers' certifications", () => {
    expect(judgePages([page("https://a.io/", "Workflow automation for finance teams.")], "a.io").verdict).toBe("fit");
    expect(judgePages([page("https://a.io/blog/soc2-guide", "Acme is SOC 2 certified.")], "a.io").verdict).toBe("fit");
    expect(judgePages([page("https://a.io/", "We help startups get SOC 2 certified.")], "a.io").verdict).toBe("fit");
    expect(judgePages([], "a.io").verdict).toBe("unreachable");
  });
});

describe("discovery: screening run", () => {
  beforeEach(() => freshDb());

  it("screens candidates with the crawler and stores the verdicts", async () => {
    const texts: Record<string, string> = { "fit.io": "Billing software for B2B teams.", "cert.io": "We are SOC 2 Type II certified." };
    const research: ResearchProvider = {
      name: "fake",
      dataSource: "real",
      startSession: (domain) => ({
        domain,
        dataSource: "real",
        initialCrawl: async () => ({ pages: [page(`https://${domain}/`, texts[domain] ?? "")], log: [], reachable: true }),
        fetchUrls: async () => ({ pages: [], log: [] }),
        unvisitedCandidates: () => [],
        pagesFetched: () => 1,
      }),
    };
    const run = startDiscovery(5, { directory: async () => [yc({ name: "Fit", website: "https://fit.io" }), yc({ name: "Cert", website: "https://cert.io" })], research });
    expect(run.started).toBe(true);
    expect(startDiscovery(5).started).toBe(false); // one screen at a time
    await run.done;
    const s = discoveryStatus();
    expect(s.running).toBe(false);
    expect(s.counts).toMatchObject({ fit: 1, certified: 1 });
    expect(s.items[0]).toMatchObject({ domain: "fit.io", verdict: "fit", inAgent: false });

    // Already-screened companies are not screened again.
    const again = startDiscovery(5, { directory: async () => [yc({ name: "Fit", website: "https://fit.io" })], research });
    await again.done;
    expect(discoveryStatus().total).toBe(0);
  });
});

describe("discovery: cases found by the real-company eval", () => {
  it("reads a question and its answer as separate sentences", () => {
    const r = judgePages([page("https://rallly.co/security", "Do you hold SOC 2 or ISO 27001 certification?Not currently.\nOur infrastructure providers are SOC 2 Type 2 and/or ISO 27001 certified.")], "rallly.co");
    expect(r.verdict).toBe("fit");
  });
  it("understands other languages and the company's own announcement post", () => {
    expect(judgePages([page("https://payflow.es/", "Estamos certificados en ISO 27001 por AENOR.")], "payflow.es").verdict).toBe("certified");
    expect(judgePages([page("https://alex.com/blog/alex-achieves-soc-2", "In 2024, Alex received certification for SOC 2 Type II compliance.")], "alex.com").verdict).toBe("certified");
    expect(judgePages([page("https://alex.com/blog/guide", "Vendors must hold SOC 2 Type II certification.")], "alex.com").verdict).toBe("fit");
  });
});

describe("discovery: status tables", () => {
  it("reads a certification heading followed by its status", () => {
    const text = "ESIGN\nStatus: Compliant\nSOC 2\nSOC2 is a framework for auditing security.\nStatus: Compliant\nISO 27001\nAn information security standard.\nStatus: Planned (2026)";
    const r = judgePages([page("https://documenso.com/compliance", text)], "documenso.com");
    expect(r.verdict).toBe("certified");
    expect(r.quote).toBe("SOC 2 — Status: Compliant");
    expect(judgePages([page("https://x.io/compliance", "ISO 27001\nA standard.\nStatus: Planned (2026)")], "x.io").verdict).not.toBe("certified");
  });
});
