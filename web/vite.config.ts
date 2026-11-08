import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { shinonome } from "./plugins/shinonome.ts";

export default defineConfig({
	// Relative, so that a copy of the site works from any address.
	base: "./",
	plugins: [react(), shinonome()],
	// The site uses the same start script as the app, which lives with the app.
	server: { fs: { allow: [".."] } },
	build: { target: "esnext", chunkSizeWarningLimit: 1500 },
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
