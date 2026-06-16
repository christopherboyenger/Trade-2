import { useRef, useState } from "react";
import { postChat, type ChatTurn } from "../api";

export function Chat({ enabled, onTraded }: { enabled: boolean; onTraded: () => void }) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setErr("");
    const next: ChatTurn[] = [...history, { role: "user", content: text }];
    setHistory(next);
    setBusy(true);
    try {
      const { reply } = await postChat(next);
      setHistory([...next, { role: "assistant", content: reply }]);
      onTraded(); // a trade may have changed holdings
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/5">
      <div className="border-b border-white/10 px-4 py-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
        Jarvis
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {history.length === 0 && (
          <div className="text-sm text-slate-500">
            {enabled
              ? 'Ask me anything — e.g. "What\'s my exposure?" or "Buy $100 of AAPL".'
              : "Chat is disabled (no ANTHROPIC_API_KEY configured on the server)."}
          </div>
        )}
        {history.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "ml-auto max-w-[90%] rounded-xl bg-sky-500 px-3 py-2 text-slate-950"
                : "mr-auto max-w-[90%] whitespace-pre-wrap rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
            }
          >
            {m.content}
          </div>
        ))}
        {busy && <div className="text-sm text-slate-500">Jarvis is thinking…</div>}
        {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{err}</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-white/10 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!enabled || busy}
          placeholder={enabled ? "Message Jarvis…" : "Chat disabled"}
          className="flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 outline-none focus:border-sky-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!enabled || busy}
          className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
