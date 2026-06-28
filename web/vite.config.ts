import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { gpxImportServer } from "./gpxImportServer";

export default defineConfig({
  plugins: [react(), gpxImportServer()],
});
