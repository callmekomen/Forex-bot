import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  server: {
    host: true,
    allowedHosts: [".e2b.app"],
    // The browser only ever calls same-origin "/api/..."; Vite forwards it to
    // the Python control plane (api_server.py). Keeps the dashboard working
    // behind remote previews, where "localhost" means the user's machine.
    proxy: {
      "/api": {
        target: process.env.FXBOT_API_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on("error", () => {
            /* control plane offline — the UI shows an "API offline" banner */
          });
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
