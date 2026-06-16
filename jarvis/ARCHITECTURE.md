# Jarvis architecture

Jarvis is the conductor. CloddsBot, Freqtrade, and OpenJarvis are the instruments;
Jarvis drives them over their APIs and presents one portfolio + one chat.

```
                         ┌──────────────────────────────┐
                         │      Dashboard (browser)      │
                         │  built-in UI  ·  OpenJarvis   │
                         │  (React/Tauri shell, next)    │
                         └───────────────┬──────────────┘
                                         │ JSON REST  (/api/*)
                         ┌───────────────▼──────────────┐
                         │        Jarvis backend         │
                         │  Express API + portfolio agg  │
                         │  Jarvis agent (Claude loop)   │
                         └───┬───────────┬───────────┬───┘
              Broker iface   │           │           │   Broker iface
                 ┌───────────▼─┐  ┌──────▼──────┐  ┌─▼──────────────┐
                 │  Alpaca     │  │  Freqtrade  │  │  Polymarket    │
                 │  (stocks)   │  │  (crypto)   │  │  (prediction)  │
                 │  REST       │  │  REST API   │  │  data API      │
                 └─────────────┘  └─────────────┘  └────────────────┘
                                   ../freqtrade        (CloddsBot can
                                   runs separately      execute trades)
```

## Why a separate `jarvis/` layer

CloddsBot is Node, Freqtrade is Python, OpenJarvis is React/Rust. Rather than weld
them together, Jarvis couples to each over its **network API**. That keeps the pieces
independently runnable and lets us add venues without touching the others.

## Key abstractions

- **`Broker` interface** (`src/brokers/broker.ts`) — every venue implements the same
  `snapshot()` / `quote()` / `placeOrder()` surface. Add IBKR, Kalshi, or a forex
  broker by writing one adapter and registering it in `registry.ts`.
- **Portfolio aggregator** (`src/portfolio.ts`) — fans out to all brokers in parallel,
  failure-isolated, and merges into one `PortfolioSnapshot`.
- **Jarvis agent** (`src/jarvis/agent.ts`) — Claude (`claude-opus-4-8`) in a *manual*
  tool-use loop. Manual (not the SDK auto-runner) so we can enforce the live-order
  confirmation gate and log every tool call. Tools map 1:1 to broker actions.

## Safety model

1. **Mode** — `paper` (default) vs `live`, global.
2. **Confirmation gate** — in live mode, `place_order` refuses to execute unless
   `confirmed: true`; the agent must surface the order and get a yes first. The
   `/api/order` endpoint enforces the same rule (HTTP 412 otherwise).
3. **Failure isolation** — a broken venue degrades to "disconnected", never a crash.
4. **No secrets in the repo** — all keys come from `.env` (gitignored).

## Roadmap (in order)

1. **Wire the OpenJarvis React frontend** as the production dashboard — add a
   "Trading" route that calls `/api/portfolio` and `/api/chat`, reusing its chat UI,
   `recharts`, and Tauri desktop packaging.
2. **Delegate Polymarket/DeFi execution to CloddsBot** via its agent/HTTP surface,
   instead of read-only.
3. **More venues** — Kalshi (prediction), IBKR (stocks/options/futures), a forex broker.
4. **Streaming chat** + per-tool-call activity in the UI.
5. **Persistence** — store chat history and a trade ledger (SQLite).
