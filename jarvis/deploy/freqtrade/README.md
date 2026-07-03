# Hosted Freqtrade (the Jarvis crypto engine)

Freqtrade is a long-running bot, so it can't live on Vercel. Run it once on a
small always-on host, then point Jarvis at it via `FREQTRADE_URL`.

This folder is a ready-to-deploy package: a **dry-run** config with the REST API
enabled, a minimal RSI strategy (so the dashboard shows live paper positions),
and a Dockerfile wrapping the official image.

## 1. Set your secrets first

Edit `config.json` → `api_server` and replace the three `CHANGE_ME_*` values:

- `password` — Jarvis sends this as `FREQTRADE_PASSWORD`. **Use a strong one** —
  the API is internet-exposed.
- `jwt_secret_key`, `ws_token` — any long random strings.

## 2. Deploy (pick one)

### Fly.io
```bash
cd jarvis/deploy/freqtrade
fly launch --no-deploy --copy-config --name jarvis-freqtrade   # first time
fly deploy
fly status   # note the https URL, e.g. https://jarvis-freqtrade.fly.dev
```

### Railway
```bash
cd jarvis/deploy/freqtrade
railway init
railway up            # builds the Dockerfile
# In the Railway dashboard: add a public domain, port 8080.
```

### Local Docker (quick test)
```bash
cd jarvis/deploy/freqtrade
docker build -t jarvis-freqtrade .
docker run -p 8080:8080 jarvis-freqtrade
# REST API → http://localhost:8080
```

## 3. Point Jarvis at it

In your **Vercel** project env vars (and/or `jarvis/.env` locally):

```
FREQTRADE_URL=https://<your-freqtrade-host>
FREQTRADE_USERNAME=jarvis
FREQTRADE_PASSWORD=<the password you set in config.json>
```

Redeploy Jarvis. The crypto venue card flips from "not connected" to live, and
`dry_run: true` makes Jarvis show it in **paper** mode.

## Notes & safety
- **Dry-run only** here — no exchange keys, no real orders. To trade live you'd
  add exchange API keys to `config.json` and set `dry_run: false` (do that
  deliberately, not by accident).
- Binance market data is geo-restricted in some regions; if data won't load,
  switch `exchange.name` to `kraken` (and adjust the pair whitelist).
- The REST API is protected by basic auth + JWT. Keep the password strong and
  consider restricting `CORS_origins` to your Jarvis domain.
