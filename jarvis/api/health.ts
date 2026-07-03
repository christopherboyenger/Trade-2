import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config, brokers } from "./_lib.js";

// Open endpoint so the login screen can detect whether a password is required.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    ok: true,
    // Login is always required; `configured` tells the UI whether a password
    // has been set yet (fail-closed until ACCESS_PASSWORD exists).
    authRequired: true,
    configured: Boolean(process.env.ACCESS_PASSWORD),
    mode: config.mode,
    jarvis: Boolean(config.anthropic.apiKey),
    venues: brokers.map((b) => ({
      name: b.name,
      assetClass: b.assetClass,
      configured: b.isConfigured(),
    })),
  });
}
