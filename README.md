# Sprinto Outreach Agent

An evidence-driven prospect research, ICP-qualification and personalised-outreach agent, built for the Mesa School of Business Sprinto case.

Paste or upload company domains, click **Run Outreach Agent**, and watch each company go through seven stages:

```
domain → 1 research website → 2 extract structured profile → 3 qualify against Sprinto's ICP (+ bounded research loop)
       → [gate: only Qualified continue] → 4 find the right decision-maker → 5 identify exactly two pain points
       → 6 write + validate a personalised email → 7 send via Gmail to YOUR OWN inbox
```

Every claim is tied to a stored piece of evidence (quote + source URL + retrieval time), labelled **observed fact**, **inference** or **unknown**. The dashboard answers the four defensibility questions for every company: *why qualify, why this person, why these pain points, why this email.*

> **Safety:** emails are written *to* the identified prospect ("Hi Jane,") but are **delivered only to `DEMO_INBOX_EMAIL`**, which must be the Gmail account you authorise. There is no code path, setting or API parameter that sends to a prospect. See [Recipient restriction](#verifying-the-recipient-restriction).

---

## Quick start (demo mode, no API keys)

Requires Node.js ≥ 22.19.

```bash
npm install
cp .env.example .env.local      # APP_MODE=demo by default
npm run dev                     # http://localhost:3000
```

Click **Load mock demo set → RUN OUTREACH AGENT**. The five `.example` companies are fictional fixtures (RFC 2606 reserved TLD) that exercise every path:

| Domain | What it demonstrates |
|---|---|
| `vaultlane.example` | Qualifies on an **audit trigger** (preparing for SOC 2), Series B; picks the Head of Security |
| `ledgerly.example` | Initially missing evidence → **research loop** finds the security page → qualifies on **enterprise pressure** with funding unknown |
| `northpeak-consulting.example` | Services firm → **Not qualified**, no contact lookup |
| `orbitboard.example` | SaaS but no buying trigger → **Needs review** (score does not override the gate) |
| `promptbait.example` | Website contains a **prompt-injection** attempt; it is flagged and ignored |

In demo mode without keys, everything is labelled **MOCK DATA** and sends show **SIMULATED** (never "Sent"). Real domains can also be entered: the website crawler is real; analysis uses the mock model until you add an LLM key.

CLI alternative: `npm run demo` (or `npm run demo -- acme.com globex.io`).

---

## Architecture

```
src/
  app/                         Next.js App Router: dashboard, company detail, API routes
    api/batches                POST domains/CSV → validate → create batch → run in background
    api/status                 dashboard metrics + provider status + company list (polled)
    api/companies/[id]         full research/evidence/decision detail
    api/companies/[id]/actions retry · manual contact · reviewer approval · retry send
    api/auth/gmail/*           server-side Google OAuth (gmail.send + openid email)
  lib/
    pipeline/orchestrator.ts   the 7-stage state machine, research loop, gate, idempotent send
    pipeline/qualification.ts  deterministic evidence enforcement, scoring, decision rules
    pipeline/contactRanking.ts deterministic contact ranking (stage-aware)
    pipeline/checks.ts         quote verification, unsupported-number detection, email rules
    prompts/                   8 separate prompt modules (research, extraction, qualification,
                               missingInformation, contactSelection, painPoint, emailGeneration,
                               emailValidation) — each with role, rules, forbidden behaviour, schema
    providers/                 replaceable adapters + mocks
      research/  WebsiteResearchProvider (bounded crawler) · Tavily search · MockResearchProvider
      llm/       AnthropicLLMProvider · MockLLMProvider · runPrompt (schema validation + retries)
      contact/   HunterContactProvider · MockContactProvider (+ manual entry)
      email/     GmailEmailProvider · MockEmailProvider · recipientGuard
    security/                  domain validation, SSRF-safe fetch, prompt-injection hygiene
    db.ts / repo.ts / queries.ts  SQLite schema, writes, read models
```

**LLM vs. code.** The model is used only where interpretation or language is needed (extracting evidence, building the profile, classifying signals, planning research, pain points, writing and critiquing the email). Deterministic code does scoring, qualification gates, evidence checks, contact ranking, validation, rate limits, retries, duplicate prevention, workflow transitions and the sending restriction.

**Evidence integrity.**
- The research model must return *verbatim quotes*; any quote not found in the fetched page text is discarded.
- Profile fields and classifications without valid evidence ids are downgraded (e.g. "Series B" without an observed quote naming the round → "growth indicators"; "customers require SOC 2" backed only by logos → "enterprise positioning").
- Numbers in pain points and emails must appear in the cited evidence.
- Inferences and unknowns are stored as their own evidence rows and never shown as facts.

### Qualification engine — 100-point rubric (configurable in `src/lib/config.ts`)
The model only **reports findings** per criterion (with evidence ids); code validates each finding against the quoted text, scores it, applies the disqualification rules and the thresholds.

| Category | Criterion | Points |
|---|---|---:|
| **Business model fit (30)** | Sells software as SaaS | 15 |
| | Serves business customers (B2B) | 10 |
| | Identifiable software product | 5 |
| **Growth stage (25)** | Series A, B or C funding | 15 |
| | 5+ open job positions | 5 |
| | Enterprise pricing or plan | 5 |
| **Compliance buying signals (35)** | Preparing for SOC 2 / ISO 27001 / similar | 20 |
| | Hiring security / compliance / GRC roles | 10 |
| | Enterprise security reviews or customer compliance requirements | 5 |
| **Enterprise readiness (10)** | Named enterprise customers or case studies | 5 |
| | Explicitly targets enterprise buyers | 5 |

Every criterion is stored with: name, max points, points awarded, evidence text, source URL, confidence and a status — **FOUND**, **NOT_FOUND** (a page that could answer it was checked), or **UNKNOWN** (no such page could be checked).

**Disqualification rules (applied first, override the score):** not SaaS → NOT_QUALIFIED · primarily B2C → NOT_QUALIFIED · an existing named certification (SOC 2, ISO 27001 …) → flag **ALREADY_CERTIFIED** and NOT_QUALIFIED (set `ALREADY_CERTIFIED_QUALIFIES=true` to score them instead) · business model can't be established → NEEDS_REVIEW. Missing information is never treated as unsuitable, and no points are awarded on assumptions (e.g. "Series B" must literally appear; "preparing for SOC 2" needs a framework *and* a preparing word; a planned certification is not a held one).

**Thresholds (`QUALIFY_THRESHOLD`, `REVIEW_THRESHOLD`):** 75–100 QUALIFIED → contact discovery, pain points, email · 55–74 NEEDS_REVIEW (fetch more pages if budget allows, else human review) · below 55 NOT_QUALIFIED. Qualification also requires confirmed SaaS **and** B2B.

**Output:** `GET /api/companies/<id>/qualification` returns the required JSON (company_name, domain, business_description, total_score, qualification_status, the four category objects with their evidence, existing_certifications, disqualification_reasons, missing_information, pages_scraped, research_summary, recommended_next_action). The company page's Qualification tab shows the same breakdown with source links, and the dashboard filters by status.

### Research loop (homepage first, targeted, bounded)
1. **One homepage request** (plain HTTP; headings, paragraphs and metadata kept; navigation, footers, cookie banners, scripts and duplicates removed). If the page renders with JavaScript and plain HTML has too little text, a headless browser (**Playwright**) renders it — same robots.txt rules, top-level navigation locked to the company's domain, private/internal addresses blocked, images/fonts/media skipped.
2. After each pass, code checks the five critical questions — *B2B SaaS? what does it sell? growth stage? compliance pressure? already certified?* — and fetches only the page type most likely to answer each open one: business model → Product/About · growth → Careers/press · compliance & certification → Security/Trust (incl. `trust.` subdomains) · enterprise → Customers/Pricing. A page type that doesn't exist on the site counts as checked.
3. **At most four additional page fetches per company** (`RESEARCH_MAX_ADDITIONAL_PAGES`, 2 per round). Pages are cached and never fetched twice. If critical evidence is still missing at the limit → NEEDS_REVIEW.
4. Cleaned content is **condensed to ~2,000 tokens** per pass (`RESEARCH_CONTEXT_CHARS`), keeping the signal-bearing lines verbatim so every quote is still verified against the full page.

Install the browser once for the JavaScript fallback: `npx playwright-core install chromium-headless-shell` (disable with `RESEARCH_BROWSER_FALLBACK=false`).

### Contact selection
Hunter Domain Search results are mapped field-by-field (missing names/titles/verification stay `null`), cached per domain (`HUNTER_CACHE_DAYS`) and counted against `HUNTER_MONTHLY_LIMIT`. Ranking is deterministic and stage-aware: early-stage → CTO/founder/COO weighted up; larger companies → CISO/Head of Security/Compliance. Contacts need a name, a relevant title and a valid on-domain email to be eligible. No eligible person → **Contact not found**, and the company page offers manual entry (e.g. from Apollo's web UI). Apollo is not scraped or called.

### Persistence
SQLite (`data/outreach.db`): companies, batches, agent_runs, stage_events, research_runs, pages, evidence, qualifications, contacts, pain_points, emails, email_sends, contact_search_cache, api_usage, llm_calls, settings. Progress survives a browser refresh. If the server restarts mid-run, runs are marked *interrupted* (retry from the company page) and any in-flight send is marked *outcome unknown*.

---

## Configuration

All settings live in `.env.local` (see `.env.example`).

### LLM
```
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...          # from console.anthropic.com — separate from any Claude subscription
LLM_MODEL=claude-opus-5-5
LLM_EFFORT=medium               # low | medium | high
```
**Gemini instead of Claude:** set `LLM_PROVIDER=gemini` and a Google AI Studio key in `LLM_API_KEY` (or `GEMINI_API_KEY`). The default model is `gemini-3.6-flash` (the newest Flash that reliably answers on free-tier keys at the time of writing); `LLM_FALLBACK_MODELS` (default `gemini-3.5-flash,gemini-3.5-flash-lite`) are tried in order when a model is overloaded (503), out of quota (429) or times out, and an unavailable model is skipped for 5 minutes. The model that actually answered is logged per call. Use `BATCH_CONCURRENCY=1` on the free tier.

Structured outputs are used so the model must return schema-shaped JSON; responses are still validated with Zod and retried once (`LLM_MAX_JSON_RETRIES`). Token usage and estimated cost per call are logged and shown. A typical qualified company costs roughly 7–12 model calls.

### Hunter.io
```
HUNTER_API_KEY=...
HUNTER_MONTHLY_LIMIT=25         # set to your plan
```
Usage this month is shown in the header chip. Re-running a company reuses the cached search.

### Gmail OAuth
1. In Google Cloud Console create a project, enable the **Gmail API**.
2. Configure the OAuth consent screen (External/Testing is fine) and add your Gmail address as a **test user**.
3. Create an **OAuth client ID** of type *Web application* with redirect URI `http://localhost:3000/api/auth/gmail/callback`.
4. In `.env.local` set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `DEMO_INBOX_EMAIL=<that same Gmail address>`. Restart `npm run dev`.
5. Click **Connect Gmail** in the dashboard banner (or open `/api/auth/gmail/start`). Sign in with that address and allow *Send email on your behalf*.

The callback verifies the Google account equals `DEMO_INBOX_EMAIL` before storing the refresh token (server-side, in the local DB). Alternatively paste a refresh token into `GMAIL_REFRESH_TOKEN`. Scopes requested: `gmail.send`, `openid`, `email` — nothing that can read your mail.

### Optional web search
`RESEARCH_PROVIDER=tavily` + `RESEARCH_API_KEY` lets the research loop run up to `RESEARCH_MAX_SEARCH_CALLS` searches per company. Without it, research is website-only and the UI says "Search: off" — it never claims to have searched the web.

### Modes
- `APP_MODE=demo` — missing credentials fall back to labelled mocks (`.example` domains only for mock research/contacts).
- `APP_MODE=live` — missing credentials make the provider unavailable; the stage fails with a setup message instead of fabricating. `.example` domains are rejected.

---

## Running with real research

```bash
# .env.local
APP_MODE=live
LLM_API_KEY=sk-ant-...
HUNTER_API_KEY=...
GMAIL_CLIENT_ID=... ; GMAIL_CLIENT_SECRET=...
DEMO_INBOX_EMAIL=you@gmail.com
```
`npm run dev`, connect Gmail, paste 3+ real SaaS domains, run. Each qualified company produces an email addressed to the real decision-maker by name, landing in your inbox with a footer noting it was a demo delivery and the prospect was not contacted.

---

## Testing

```bash
npm test            # vitest: 114 tests, no network
npm run typecheck
npm run lint
npm run build
npm run eval        # accuracy eval with the real LLM (see below)
```

### Accuracy eval (`npm run eval`)
[`eval/qualification-cases.ts`](eval/qualification-cases.ts) holds 14 labelled fictional companies (`.example`, nothing real is contacted), each with the decision a careful analyst would reach. They include the traps that break keyword matching: "not yet SOC 2 certified", "not just compliant — certified", ISO held but SOC 2 planned, a compliance vendor that *helps others* get SOC 2, a B2C app, an agency, hardware, a borderline company and a prompt-injection page. The eval runs the real research and qualification prompts plus the deterministic rubric and reports per-case results (`data/eval-results.json`). Add a case whenever a live run gets something wrong.

Coverage maps to the case's checklist: SaaS recognition, non-SaaS rejection, Series A–C, unknown stage, audit-only and enterprise-only qualification (OR logic), weak evidence downgrades, needs-review, deterministic scoring, research-loop maximum, qualification gate (no contact lookup for unqualified companies), contact ranking by stage, missing/invalid contacts, Hunter rate-limit/quota and caching, structured extraction, malformed-JSON retries, exactly-two evidence-backed pain points, email personalisation and validation, bounded regeneration (failed emails never sent), prospect name/company in body, recipient restricted to own inbox, prospect never in To/Cc/Bcc/body, Gmail auth failure, wrong Google account, duplicate prevention, failed and unknown-outcome sends, mock vs real send, SSRF, robots.txt, domain/CSV parsing and prompt-injection hygiene.

---

## Verifying the recipient restriction

1. **Structure:** `EmailProvider.send()` takes `{subject, body, prospectEmails}` — there is no recipient argument. Providers read `DEMO_INBOX_EMAIL` themselves.
2. **Before each send** (`GmailEmailProvider.verifyIdentity`): token refresh → Google `tokeninfo` → the authenticated, verified email must equal `DEMO_INBOX_EMAIL` (and `GMAIL_SENDER_EMAIL` if set), and the token must carry `gmail.send`. Otherwise sending is blocked.
3. **On the exact bytes sent** (`recipientGuard.assertMessageSafe`): exactly one `To:` equal to the demo inbox; no `Cc`, `Bcc`, `Resent-*`; no prospect address anywhere in headers or decoded body. Subject CR/LF are stripped (no header injection).
4. **Tests:** `tests/email.test.ts` decodes the raw message actually posted to Gmail and asserts `To: <demo inbox>` and the absence of the prospect address.
5. **In the UI:** each company's *Personalised email* section shows "Prospect (contact metadata only)" separately from "Delivery recipient: your own inbox", and *Delivery status* shows the recipient and Gmail message id.

Only a Gmail-confirmed response (with a message id) is recorded as **Sent**. Network timeouts are recorded as **outcome unknown** and are never retried automatically; the UI asks you to check your inbox and confirm before resending.

---

## Sharing a public, view-only link (tunnel from your Mac)
The app runs as a long-lived local server with a SQLite file and background jobs, so it is shared through a tunnel rather than a serverless host:

```bash
# 1. in .env.local
ALLOWED_HOSTS=*.trycloudflare.com

# 2. build and start (terminal 1)
npm run build && npm start -- -p 3123

# 3. open a tunnel (terminal 2) — prints https://<random>.trycloudflare.com
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3123
```
There is no sign-in. Through the shared link the app is **view-only**: anyone with the link can browse the dashboard, research, evidence, contacts, pain points and emails (email addresses are partly masked), but every write — running the agent, adding contacts, approving, (re)sending, Gmail authorisation — is refused and only works on `http://localhost:3123`. The link works only while both commands run and your Mac is awake, and a quick tunnel gets a new random address each time it starts.

## Public link on Vercel (read-only, via Supabase)
A permanent link that works even when your Mac is off. The agent still runs only on your Mac; Vercel shows the latest published results and cannot run anything, send email or see any key except the public read key.

1. Create a Supabase project and run [`supabase/showroom.sql`](supabase/showroom.sql) in its SQL editor (one table, public **read-only** by row-level security).
2. On the Mac: `bash scripts/set-keys.sh --supabase` — Project URL, anon key, service_role key (the write key stays in `.env.local`).
3. Publish: `npm run snapshot`. After that the app republishes automatically when a batch or a resend finishes.
4. In Vercel → Settings → Environment Variables add **only** `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then redeploy.

What gets published: the dashboard, research, evidence, qualification reports, contacts, pain points and drafted emails, with every email address partly masked (publishing refuses if a full address remains). Nothing is committed to GitHub.

## Security hardening (local app)
- The server binds to `127.0.0.1` only (`npm run dev` / `npm start`).
- `src/middleware.ts` rejects API requests whose `Host` isn't loopback (DNS rebinding) and any state-changing request that isn't same-origin JSON (CSRF). Add `ALLOWED_HOSTS` only for a tunnel you control.
- The `data/` folder and database (which hold the Gmail refresh token) are owner-only (0700/0600).
- The crawler reads each host's robots.txt before any page, stays on the company's domain on every redirect hop, and never crawls shared suffixes such as `github.io` or `co.uk`.
- Untrusted text (page titles, company names, provider job titles) is sanitised before reaching a prompt; sentences recovered from hidden page data or third-party search results are stored as inference, never as fact.
- Numbers in emails must match a value **and unit** in the cited evidence; no email address may appear in an email.
- Criterion patterns are checked against the **verbatim page quote only**, never the model's own claim, so the model can't talk a company into points. Negated ("not yet certified"), planned ("preparing for our attestation") and vendor wording ("we help startups get SOC 2") never count as already certified; blog/docs articles never count as the company's own audit preparation.
- Funding found through search (`RESEARCH_PROVIDER=gemini` = Google Search via Gemini grounding) is used only to find article URLs; the article itself is fetched and quoted verbatim, labelled as third-party, and it can only satisfy the funding criterion.
- Shared-link and public viewers see an allowlist: the selected decision-maker's name and title only (no other people, no addresses, no Gmail ids), with every email address masked (including `%40` forms). A request is "local" only if its Host is loopback **and** no proxy header (`X-Forwarded-For`, `CF-Connecting-IP`, `Forwarded`…) names a remote client.
- Only one server process may run the agent per database (`data/outreach.db.lock`), so two copies can't double-send. "Approve" works only on *needs review* companies, never on a disqualification.
- robots.txt: a server error or timeout means "disallowed" (RFC 9309); redirects are re-checked. The headless-browser fallback never touches the network itself — every request goes through the SSRF-safe fetcher (pinned DNS, ports 80/443, GET only, WebSockets closed).
- Mock data is always SIMULATED, even when Gmail is connected. One email per company per campaign; ambiguous Gmail outcomes (timeouts, 5xx) require confirmation before a resend.

## Limitations (honest notes)
- JavaScript-only websites yield less text to a plain HTTP crawler (embedded page data is recovered as inference only); such companies may end up *Needs review*.
- Hunter has no people for some small companies; then add the decision-maker manually (e.g. from the company's own team page or Apollo).
- Without a search provider, funding and customer-pressure signals that are not on the company's own site will remain unknown.
- The mock model is a keyword heuristic for offline demos; real qualification quality requires an LLM key.
- Background jobs run inside the Node server process (no queue); fine for 8–50 domains per batch, not for large-scale use.
