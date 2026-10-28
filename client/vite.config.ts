import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Absolute imports like the NueAssist UI: "components/...", "utils/...", "screens/..."
    alias: {
      components: path.resolve(__dirname, "src/components"),
      screens: path.resolve(__dirname, "src/screens"),
      utils: path.resolve(__dirname, "src/utils"),
    },
  },
  server: {
    port: 5173,
    // The browser calls /api on the same origin; Vite forwards it to the API server.
    proxy: { "/api": "http://localhost:5050" },
  },
});
