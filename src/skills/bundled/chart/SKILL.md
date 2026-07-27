---
name: chart
description: "AI chart analysis: reads price/volume/structure, finds key levels, builds a trade plan, and risk-reviews it before you trade"
commands:
  - /chart
  - /opus
---

# Chart Analysis — the OPUS 5 pipeline

Runs a professional-analyst workflow on any crypto chart, in seconds:

1. **Reads the chart** — price action, volume, market structure, trend & bias
2. **Finds the key levels** — support, resistance, liquidity pools, supply & demand zones
3. **Builds the trade plan** — entry, stop loss, target, risk/reward
4. **Risk review** — position size from balance × risk %, max-loss check, exposure balance, confidence score

Only high-probability setups get a ✅ TAKE TRADE verdict; everything else is ⛔ STAND ASIDE with the reasons spelled out. **Analysis only — this skill never places orders.**

Candles come from Binance public REST (no API key needed).

## Quick Start

```
/chart BTC                 # Full analysis, 1h candles
/chart ETH 4h              # Different interval
/chart SOL 1d --balance 5000 --risk 2
```

## Commands

### Full analysis
```
/chart <SYMBOL> [interval] [flags]
```

### Focused views
```
/chart levels <SYMBOL> [interval]    Key levels only
/chart plan <SYMBOL> [interval]      Trade plan + risk review only
```

### Flags
```
--balance N        Account balance for sizing (default 1000)
--risk N           Risk % per trade (default 1)
--max-loss N       Max per-trade loss as % of balance (default 20)
--max-exposure N   Total exposure cap as % of balance (default 100)
--open N           Open exposure notional to count against the cap (default 0)
--rr N             Minimum reward:risk to accept a setup (default 1.5)
--confidence N     Minimum confidence score to approve (default 60)
```

Intervals: any Binance kline interval (`1m 5m 15m 1h 4h 1d 1w`, default `1h`).

## How the verdict works

A setup is **approved** only when all of these hold:

- A directional edge exists (trend bias or clean HH-HL / LH-LL structure)
- Reward:risk ≥ the `--rr` minimum (target anchored to a real level)
- Risk amount fits inside the max-loss budget
- Total exposure (this position + `--open`) stays under the cap
- Confidence score ≥ the `--confidence` floor (trend strength, structure
  agreement, volume participation, R:R quality, momentum)
