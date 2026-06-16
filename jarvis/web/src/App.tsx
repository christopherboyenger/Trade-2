import { useCallback, useEffect, useState } from "react";
import {
  clearToken,
  getHealth,
  getPortfolio,
  getToken,
  type Health,
  type Portfolio,
} from "./api";
import { Login } from "./components/Login";
import { Chat } from "./components/Chat";

const usd = (n?: number) =>
  n == null || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const num = (n?: number) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US"));
const pnlColor = (n?: number) => (n == null ? "" : n >= 0 ? "text-emerald-400" : "text-red-400");

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [authed, setAuthed] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPortfolio(await getPortfolio());
    } catch (e) {
      if ((e as Error).message === "unauthorized") setAuthed(false);
    }
  }, []);

  // Bootstrap: figure out whether a password is required and whether we have one.
  useEffect(() => {
    getHealth().then((h) => {
      setHealth(h);
      if (!h.authRequired || getToken()) setAuthed(true);
    });
  }, []);

  // Poll the portfolio while authed.
  useEffect(() => {
    if (!authed) return;
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  if (health?.authRequired && !authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  const live = (portfolio?.mode ?? health?.mode) === "live";

  return (
    <div className="mx-auto max-w-6xl p-4">
      {/* Header */}
      <header className="mb-4 flex items-center justify-between">
        <div className="text-xl font-bold tracking-widest text-sky-400">⬡ JARVIS</div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              "rounded-full px-3 py-1 font-semibold " +
              (live ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400")
            }
          >
            {live ? "LIVE" : "PAPER"}
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1 text-slate-400">
            brain: {health?.jarvis ? "on" : "off"}
          </span>
          {health?.authRequired && (
            <button
              onClick={() => {
                clearToken();
                setAuthed(false);
              }}
              className="rounded-full bg-white/5 px-3 py-1 text-slate-400 hover:text-white"
            >
              log out
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
        {/* Left: portfolio */}
        <div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="text-xs uppercase tracking-widest text-slate-400">Total equity</div>
            <div className="mt-1 text-4xl font-bold">{usd(portfolio?.totalEquity)}</div>
            <div className={"mt-1 font-semibold " + pnlColor(portfolio?.totalUnrealizedPnl)}>
              {portfolio
                ? `${portfolio.totalUnrealizedPnl >= 0 ? "+" : ""}${usd(portfolio.totalUnrealizedPnl)} unrealized`
                : "…"}
            </div>
            {portfolio && (
              <div className="mt-2 text-[11px] text-slate-500">
                as of {new Date(portfolio.asOf).toLocaleTimeString()}
              </div>
            )}
          </div>

          {/* Venue cards */}
          <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(portfolio?.venues ?? []).map((v) => {
              const dot = !v.configured
                ? "bg-slate-500"
                : v.connected
                  ? "bg-emerald-400"
                  : "bg-red-400";
              return (
                <div key={v.venue} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center gap-2 font-semibold capitalize">
                    {v.venue}
                    <span className={"inline-block h-2 w-2 rounded-full " + dot} />
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {v.assetClass} · {v.mode}
                  </div>
                  <div className="mt-1 text-lg font-bold">
                    {v.balance ? usd(v.balance.equity) : v.configured ? "—" : "not connected"}
                  </div>
                  {v.error && <div className="mt-1 text-[11px] text-red-400">{v.error}</div>}
                </div>
              );
            })}
          </div>

          {/* Positions */}
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-400">Positions</div>
          <div className="overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full text-right text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Venue</th>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Avg</th>
                  <th className="px-3 py-2">Mark</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {(portfolio?.venues ?? []).flatMap((v) => v.positions).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                      No open positions.
                    </td>
                  </tr>
                ) : (
                  (portfolio?.venues ?? [])
                    .flatMap((v) => v.positions)
                    .map((p, i) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="px-3 py-2 text-left">{p.venue}</td>
                        <td className="px-3 py-2 text-left">{p.symbol}</td>
                        <td className="px-3 py-2">{num(p.quantity)}</td>
                        <td className="px-3 py-2">{usd(p.avgPrice)}</td>
                        <td className="px-3 py-2">{usd(p.markPrice)}</td>
                        <td className="px-3 py-2">{usd(p.marketValue)}</td>
                        <td className={"px-3 py-2 " + pnlColor(p.unrealizedPnl)}>{usd(p.unrealizedPnl)}</td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: chat */}
        <div className="h-[70vh] lg:h-auto">
          <Chat enabled={Boolean(health?.jarvis)} onTraded={refresh} />
        </div>
      </div>

      <p className="mt-4 text-center text-[11px] text-slate-600">
        Not financial advice. Paper mode by default; live orders require confirmation.
      </p>
    </div>
  );
}
