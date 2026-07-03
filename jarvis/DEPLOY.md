# Deploying Jarvis

Jarvis (dashboard + API) runs on **Vercel**. The crypto engine (Freqtrade) and
the CloddsBot agent are long-running services that run **off** Vercel and are
reached over HTTP.

```
   Vercel  ──────────────►  jarvis/web (static)  +  jarvis/api (functions)
                                   │  calls over HTTPS
              ┌────────────────────┼─────────────────────┐
         Alpaca REST         Freqtrade REST          Polymarket API
        (stocks, paper)     (crypto — you host)      (predictions, public)
```

## 1. Deploy the dashboard to Vercel (push-to-deploy)

Connecting the repo gives you **automatic push-to-deploy** — no token, no CLI.

1. Vercel → **Add New → Project → Import** `christopherboyenger/Trade-2`.
2. **Root Directory → `jarvis`** (required — so `/api/*` routes and the web build resolve).
3. Framework Preset: **Other** (`vercel.json` provides build + output).
4. Add the environment variables below.
5. **Deploy.** From now on, every push to a branch creates a preview deploy and
   pushes to the production branch update production — that *is* push-to-deploy.

### Environment variables

| Key | Required? | Purpose |
|-----|-----------|---------|
| `ACCESS_PASSWORD` | **Yes** | Unlocks the private preview. Until set, the API is **locked** (fails closed). |
| `TRADING_MODE` | recommended | `paper` (default-safe) or `live`. |
| `ANTHROPIC_API_KEY` | for chat | Enables the Jarvis brain. |
| `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY` | for stocks | Alpaca paper account. |
| `FREQTRADE_URL` / `FREQTRADE_USERNAME` / `FREQTRADE_PASSWORD` | for crypto | Your hosted Freqtrade (step 3). |
| `POLYMARKET_ADDRESS` | optional | Your wallet, to show prediction positions. |

> The chat function is set to `maxDuration: 60`. On Vercel Hobby, enable **Fluid
> Compute** (or upgrade) so the Claude tool-loop isn't capped at ~10s.

## 2. (Optional) Let CI/an agent deploy from a shell

Push-to-deploy already covers normal use. If you also want to run deploys from a
terminal or have an agent do it, add a **`VERCEL_TOKEN`** to the environment, then:

```bash
cd jarvis && npx vercel link && npx vercel deploy --prod --token "$VERCEL_TOKEN"
```

## 3. Host the crypto engine (Freqtrade)

See [`deploy/freqtrade/README.md`](./deploy/freqtrade/README.md) — a ready-to-deploy
dry-run Freqtrade with the REST API enabled (Fly.io / Railway / Docker). Deploy it,
then set `FREQTRADE_URL` (+ user/pass) in Vercel and redeploy. The crypto card
flips from "not connected" to live paper positions.

## Security recap
- Auth **fails closed**: no `ACCESS_PASSWORD` ⇒ everything locked.
- `paper` mode by default; **live orders require explicit confirmation** in both
  the agent tool and `/api/order`.
- No secrets in the repo — all keys are Vercel env vars / your Freqtrade host.
