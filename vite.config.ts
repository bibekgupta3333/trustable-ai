import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The client runs on Vite (5173) in dev and proxies /api to the Express server (3001).
// In production `npm start` serves dist/ and the API from the same Express process.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" },
  },
  build: { outDir: "dist" },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["{src,shared,server,api}/**/*.test.{ts,tsx}"],
  },
});
