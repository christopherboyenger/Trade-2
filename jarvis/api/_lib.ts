import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../src/config.js";
import { buildBrokers } from "../src/brokers/registry.js";

// Brokers are cheap to construct and stateless; build once per cold start.
export const brokers = buildBrokers(config);
export { config };

/**
 * Shared-secret gate for the private preview. Fails CLOSED: if ACCESS_PASSWORD
 * is not configured, every protected endpoint is locked (503) rather than open,
 * so a freshly-deployed URL can never be an unprotected trading API. Set
 * ACCESS_PASSWORD in the Vercel project to unlock; clients send it as the
 * `x-access-token` header.
 */
export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const pw = process.env.ACCESS_PASSWORD ?? "";
  if (!pw) {
    res.status(503).json({ error: "Access not configured — set ACCESS_PASSWORD in Vercel." });
    return false;
  }
  const token = (req.headers["x-access-token"] as string | undefined) ?? "";
  if (token !== pw) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
