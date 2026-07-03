---
name: challenge
description: "$1k->$10k risk-managed paper-trading challenge: status, equity, promotion gates, kill switch"
emoji: "🎯"
---

# $1,000 -> $10,000 Challenge

Fully risk-managed, paper-trading-first autonomous trading challenge. Two
isolated sleeves ($500 crypto trend-following + $500 prediction-market
value/arb) trade live market data with simulated fills. Real money is never
touched: when every promotion gate is green the system only flags
eligibility for review.

Enable it in config: `trading.challenge.enabled = true` (no API keys needed).
Optional: `trading.challenge.bankroll` (default 1000 — sleeves and position
caps scale with it) and `trading.challenge.goal` (default 10x bankroll).
Changing the bankroll of an existing run takes effect after `/challenge reset`.

## Commands

- `/challenge status` — equity, drawdown, sleeve balances, open positions
- `/challenge gates` — promotion gate report (trades, profit factor, drawdown, significance)
- `/challenge positions` — open paper positions with stops
- `/challenge trades [n]` — recent fills with PnL and reasons
- `/challenge kill [reason]` — kill switch: flatten everything, halt trading
- `/challenge rearm` — resume after a kill (acknowledges the kill event)
- `/challenge reset` — wipe and restart from the configured bankroll

## Risk rules (enforced, not advisory)

- 1% of sleeve equity risked per trade; mandatory stop on every position
- Daily loss cap 5% of bankroll -> halted until next UTC day
- Max drawdown 15% from peak -> kill switch, manual rearm required
- 4 consecutive losses -> sleeve breaker (4h cooldown)
- Max 2 concurrent positions and 10 trades/day per sleeve
- Entries blocked on stale market data; exits always allowed
