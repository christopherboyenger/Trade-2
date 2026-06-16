import { config } from "./config.js";
import { buildBrokers } from "./brokers/registry.js";
import { createServer } from "./server.js";

const brokers = buildBrokers(config);
const app = createServer(config, brokers);

app.listen(config.port, () => {
  const venues = brokers
    .map((b) => `${b.name}${b.isConfigured() ? "" : " (not configured)"}`)
    .join(", ");
  console.log("");
  console.log("  ╦ ╔═╗╦═╗╦  ╦╦╔═╗   Jarvis trading dashboard");
  console.log("  ║ ╠═╣╠╦╝╚╗╔╝║╚═╗   mode: " + config.mode.toUpperCase());
  console.log("  ╚═╝╩ ╩╩╚═ ╚╝ ╩╚═╝   brain: " + (config.anthropic.apiKey ? "on" : "off (no API key)"));
  console.log("");
  console.log(`  venues: ${venues}`);
  console.log(`  dashboard → http://localhost:${config.port}`);
  console.log("");
  if (config.mode === "live") {
    console.log("  ⚠️  LIVE mode — real orders are possible. Live orders still require confirmation.");
    console.log("");
  }
});
