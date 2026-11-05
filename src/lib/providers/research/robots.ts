/** Small robots.txt parser: groups for our UA or "*", longest-match Allow/Disallow, Crawl-delay, Sitemap. */
export interface RobotsRules {
  allowed(path: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
}

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase().split("/")[0];
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(val);
    else if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    else if (cur && key === "crawl-delay") {
      const d = Number(val);
      if (Number.isFinite(d)) cur.delay = d;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.path !== "" || !r.allow);
  const delay = chosen.map((g) => g.delay).find((d) => d !== null) ?? null;

  const matches = (pattern: string, path: string) => {
    if (pattern === "") return false;
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"),
    );
    return re.test(path);
  };

  return {
    allowed(path: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (r.path === "") continue; // "Disallow:" (empty) allows everything
        if (matches(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) {
          best = { allow: r.allow, len: r.path.length };
        }
      }
      return best ? best.allow : true;
    },
    crawlDelayMs: delay === null ? null : Math.min(delay, 10) * 1000,
    sitemaps,
  };
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, crawlDelayMs: null, sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { allowed: () => false, crawlDelayMs: null, sitemaps: [] };
