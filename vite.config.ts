import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";

export default defineConfig({
  root: realpathSync("src"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
