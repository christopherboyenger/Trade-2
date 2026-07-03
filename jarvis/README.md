# Jarvis — AI trading dashboard

One AI-driven dashboard that trades **stocks, crypto, and prediction markets** from
a single chat box and a unified portfolio view.

Jarvis is the **orchestration layer** that ties the other projects in this repo together:

| Venue | Asset class | Engine |
|-------|-------------|--------|
| **Alpaca** | stocks / ETFs | direct REST (paper + live) |
| **Freqtrade** (`../freqtrade`) | crypto | Freqtrade REST API |
| **Polymarket** | prediction markets | public data API (read-only MVP) |
| **CloddsBot** (repo root) | crypto / Polymarket / DeFi | the richer Claude trading agent (future delegate) |

The **brain** is Claude (`claude-opus-4-8`) driving a tool-use loop over a uniform
`Broker` interface, so every venue looks the same to the agent and the UI.

## Quick start

```bash
cd jarvis
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY + any venue keys you have
npm run dev                   # http://localhost:8088
```

**Nothing is required to boot.** With an empty `.env` the dashboard still runs —
each unconfigured venue shows "not connected". Add credentials to light venues up:

- **Chat (Jarvis brain):** `ANTHROPIC_API_KEY`
- **Stocks:** Alpaca **paper** keys → `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY`
- **Crypto:** run Freqtrade with its REST API enabled, set `FREQTRADE_URL` (+ basic-auth user/pass)
- **Prediction markets:** `POLYMARKET_ADDRESS` (your wallet) to see positions

## Paper vs live

`TRADING_MODE=paper` (default) wires Alpaca to its paper sandbox; Freqtrade reports
its own dry-run flag. Set `TRADING_MODE=live` to allow real orders — and even then,
**live orders never execute without explicit confirmation** (enforced in both the
agent tool and the `/api/order` endpoint).

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/health` | mode, brain on/off, configured venues |
| `GET` | `/api/portfolio` | unified balances + positions + P&L |
| `GET` | `/api/quote?venue=&symbol=` | latest price |
| `POST` | `/api/order` | place an order (`confirmed:true` required in live) |
| `POST` | `/api/chat` | `{ history: [...] }` → Jarvis reply |

## The dashboard UI

The built-in dashboard (`public/`) is a zero-build reference UI so the system runs
end-to-end today. The **production dashboard shell is OpenJarvis** (`../openjarvis/frontend`,
React 19 + Vite + Tailwind + Tauri) — it consumes this same JSON API; wiring its
"Trading" view to these endpoints is the next step. See `ARCHITECTURE.md`.

## ⚠️ Disclaimer

This is software for managing trades you authorize — it is not financial advice and
can lose real money in live mode. Start in paper mode, use small amounts, and review
every live order.
