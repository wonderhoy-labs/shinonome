import { defineConfig } from "vite";

// Builds the script for the page the phone serves over Wi-Fi. The result is committed, so that building the
// APK doesn't need Node, and CI checks that it matches this source.
export default defineConfig({
	// This builds into the APK's assets, and the site's public folder doesn't belong there.
	publicDir: false,
	build: {
		// Any browser on the network can open the phone's page, so its script stays a little behind the newest.
		target: "es2022",
		minify: false,
		outDir: "../android/app/src/main/assets/web",
		emptyOutDir: false,
		lib: {
			entry: "src/phone-page/main.ts",
			formats: ["iife"],
			name: "shinonomeClient",
			fileName: () => "client.js",
		},
		rollupOptions: {
			output: {
				banner: "// Generated from web/src/phone-page and web/src/session. Change those and run pnpm build:phone-page.",
			},
		},
	},
});
