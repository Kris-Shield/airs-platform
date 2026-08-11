import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        visibilityCheck: resolve(__dirname, "visibility-check.html"),
      },
    },
  },
  preview: {
    allowedHosts: [".up.railway.app"],
  },
});
