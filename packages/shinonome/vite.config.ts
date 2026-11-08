import { defineConfig } from "vitest/config";

// The library's own build. Dependencies stay outside it, and the start script is inlined, so the package works
// with any bundler. The APK sits beside it as a file of its own.
export default defineConfig({
	server: { fs: { allow: ["../.."] } },
	build: {
		target: "es2022",
		minify: false,
		lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
		rollupOptions: { external: [/^@yume-chan\//] },
	},
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
