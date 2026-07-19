import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: false,
    watch: {
      // Playwright writes acceptance screenshots and traces inside the repository.
      // They are evidence, not application inputs; watching them can reload another
      // concurrent E2E page while it is interacting with an otherwise stable control.
      ignored: ["**/artifacts/**", "**/test-results/**", "**/playwright-report/**"]
    }
  },
  build: {
    target: "es2020"
  }
});
