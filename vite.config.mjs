import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { profileApi } from "./scripts/profile-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";
import { stylistApi } from "./scripts/stylist-api.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "localhost",
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "localhost",
      port: 4173,
    },
    plugins: [react(), responsiveImageApi(), wardrobeImportApi({ env }), stylistApi({ env }), profileApi({ env })],
  };
});
