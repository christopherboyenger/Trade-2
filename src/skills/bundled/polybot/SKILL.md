---
name: polybot
description: "Polymarket auto-trader: fuses whale-follow and spot-momentum signals with confidence gating, decision traces, and paper mode by default"
commands:
  - /polybot
  - /pb
---

# PolyBot — Polymarket auto-trader

Watches two signal streams and trades Polymarket binaries when a candidate
clears every gate:

- **whale** — follows large Polymarket prints (default ≥ $10k) into the side
  the whale bought
- **momentum** — spot moves on Binance (BTC/ETH/SOL/XRP/DOGE) mapped onto the
  active 15-minute up-or-down markets

Every candidate — placed or skipped — lands in a **decision trace**
(`signal → gate → exec`) so you can always see why a trade did or didn't
happen. **Starts in paper mode**: no real orders unless you pass `--live`
with Polymarket credentials configured.

## Quick Start

```
/pb start                 # Paper trading, whale + momentum
/pb status                # Session P&L, win rate, positions, feeds
/pb why                   # "Why isn't it trading?" checklist
/pb stop
```

## Commands

### Start / Stop
```
/pb start [--live] [--size N] [--conf 0.6] [--assets BTC,ETH,SOL]
/pb stop
```
`--live` requires POLY_PRIVATE_KEY etc. (same credentials as /div). Without
it, fills are simulated locally against a paper balance.

### Monitor
```
/pb status       Session P&L, win rate, open positions, signals/min, feeds
/pb positions    Open positions + last closed trades
/pb trace        Decision trace: signal → gate → exec, with confidence
/pb log          Live trade log (backend / trader / whale / momentum lines)
/pb why          Diagnostics checklist — every reason trading could be halted
```

### Configure
```
/pb config                          Show config
/pb config --conf 0.65              Confidence floor (0..1)
/pb config --size 25                $ per trade
/pb config --spread 4               Max spread in cents
/pb config --max-pos 25             Max concurrent positions
/pb config --daily-loss 100         Daily loss cap in $
/pb config --whale-min 10000        Min whale print in $
/pb config --master on|off          Master switch
```

## Gate chain

Candidates are rejected by the first failing gate, in order: master switch,
confidence floor, price band (5c–85c), spread cap, market window, duplicate
position, cooldown, position cap, exposure cap, daily loss cap. The failing
gate's reason is logged verbatim in the trace (e.g. `skip: spread 7c > max 4c`).
