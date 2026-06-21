import { defineConfig } from "vite";

// CE Host is a pure-web SPA that talks to a local CE node's HTTP+SSE API.
// In dev we proxy `/ce/*` to the node on :8844 so the browser is same-origin
// with the API (avoids CORS during development; production deployments either
// run same-origin behind a reverse proxy or set CE_HOST_NODE_URL at build time).
export default defineConfig({
  server: {
    port: 5180,
    proxy: {
      "/ce": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
