import { resolve } from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/** Where `bun run start` serves the API by default (server/src/main.ts). */
const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:4317"

/**
 * Extra hosts that the dev server accepts, for a tunnel (for example
 * `VITE_ALLOWED_HOSTS=.example.com`). A comma separates the hosts.
 */
const ALLOWED_HOSTS = (process.env.VITE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // In development, Vite serves the app and proxies the API to the server (spec 4.1).
    proxy: { "/api": API_TARGET },
    allowedHosts: ALLOWED_HOSTS,
  },
})
