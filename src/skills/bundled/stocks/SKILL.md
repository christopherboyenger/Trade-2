---
name: stocks
description: US stocks & ETFs trading via Alpaca (paper-first)
emoji: "📈"
commands:
  - /stocks
gates:
  envs:
    - ALPACA_API_KEY
---

# Stocks (Alpaca)

Trade US stocks and ETFs through Alpaca. **Paper trading by default** — live
trading requires live API keys plus an explicit `ALPACA_LIVE_TRADING=true`.
`DRY_RUN=true` simulates order placement without calling the API at all.

## Quick Start

```bash
# Set credentials (paper keys from https://app.alpaca.markets)
export ALPACA_API_KEY="your-key-id"
export ALPACA_API_SECRET="your-secret-key"

# Check account
/stocks account

# Buy 10 shares of AAPL at market
/stocks buy AAPL 10

# Buy $500 worth of SPY (fractional, market order)
/stocks buy SPY $500
```

## Commands

### Account

| Command | Description |
|---------|-------------|
| `/stocks account` | Equity, cash, buying power |
| `/stocks positions` | Open positions with P&L |
| `/stocks orders` | Open orders |

### Trading

| Command | Description |
|---------|-------------|
| `/stocks buy <symbol> <qty\|$amount> [limitPrice]` | Buy shares (market, or limit if price given) |
| `/stocks sell <symbol> <qty\|$amount> [limitPrice]` | Sell shares |
| `/stocks close <symbol>` | Close a position |
| `/stocks closeall` | Close all positions |
| `/stocks cancel <orderId\|all>` | Cancel order(s) |

### Market Data

| Command | Description |
|---------|-------------|
| `/stocks quote <symbol>` | Last trade + bid/ask |
| `/stocks clock` | Market open/closed, next open/close |

## Examples

```bash
/stocks quote NVDA             # Latest price and bid/ask
/stocks buy AAPL 10 185.50     # Limit buy 10 AAPL at $185.50
/stocks sell TSLA $1000        # Sell $1000 of TSLA at market
/stocks close AAPL             # Flatten AAPL position
/stocks clock                  # Is the market open?
```

## Modes

| Mode | How | Endpoint |
|------|-----|----------|
| Paper (default) | Paper API keys | paper-api.alpaca.markets |
| Live | Live keys + `ALPACA_LIVE_TRADING=true` | api.alpaca.markets |
| Dry run | `DRY_RUN=true` | No orders sent |

Notes:
- Notional (`$amount`) orders are always market orders (Alpaca restriction).
- Orders default to `day` time-in-force.
- Every response is tagged `[PAPER]` or `[LIVE]` so you always know which mode you're in.
