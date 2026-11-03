"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { postJson } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/session", { password });
      // only same-site paths are allowed as a redirect target
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ maxWidth: 380, margin: "12vh auto 0" }} onSubmit={submit}>
      <div className="brand" style={{ marginBottom: 14 }}>
        <div className="logo">S</div>
        <div>
          <h1>Sprinto Outreach Agent</h1>
          <div className="sub">Sign in to continue</div>
        </div>
      </div>
      <label className="field" htmlFor="pw">Password</label>
      <input id="pw" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%", font: "inherit", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "9px 10px" }} />
      {error && <div className="notice n-bad" style={{ marginTop: 10 }}>{error}</div>}
      <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="shell">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
