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
caps scale with it), `trading.challenge.goal` (default 10x bankroll), and
`trading.challenge.riskLevel` 1-5 (default 3). The risk dial scales exposure —
risk per trade 0.5%→2.5%, position caps 15%→40% of the crypto sleeve (half
that for the prediction sleeve), entry channel
Donchian 30→10 — but never the safety rails: the daily halt, drawdown kill
switch, stops and breakers are identical at every level.
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

- Risk per trade set by the risk dial: 0.5%-2.5% of sleeve equity (1% at default level 3); mandatory stop on every position
- Daily loss cap 5% of bankroll -> halted until next UTC day
- Max drawdown 15% from peak -> kill switch, manual rearm required
- 4 consecutive losses -> sleeve breaker (4h cooldown)
- Max 2 concurrent positions and 10 trades/day per sleeve
- Entries blocked on stale market data; exits always allowed
