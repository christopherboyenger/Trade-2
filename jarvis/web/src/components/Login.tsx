import { useState } from "react";
import { getPortfolio, setToken } from "../api";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setToken(pw);
    try {
      await getPortfolio(); // validates the password against a protected route
      onAuthed();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg === "unauthorized" ? "Wrong password." : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur"
      >
        <div className="mb-1 text-2xl font-bold tracking-widest text-sky-400">⬡ JARVIS</div>
        <p className="mb-6 text-sm text-slate-400">Private preview — enter the access password.</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Access password"
          className="mb-3 w-full rounded-lg border border-white/10 bg-slate-950 px-4 py-3 outline-none focus:border-sky-500"
        />
        {err && <div className="mb-3 text-sm text-red-400">{err}</div>}
        <button
          type="submit"
          disabled={busy || !pw}
          className="w-full rounded-lg bg-sky-500 px-4 py-3 font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
