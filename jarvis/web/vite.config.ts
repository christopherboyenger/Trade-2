import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Local dev proxies API calls to the Express dev server (npm run dev in ../).
    proxy: { "/api": "http://localhost:8088" },
  },
});
