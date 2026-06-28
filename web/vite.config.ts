import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { gpxImportServer } from "./gpxImportServer";

export default defineConfig({
  plugins: [react(), gpxImportServer()],
});
