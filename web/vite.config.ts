import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_WEB_PORT ?? 7101),
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT ?? process.env.PORT ?? "7302"}`,
        changeOrigin: true,
      },
    },
  },
});
