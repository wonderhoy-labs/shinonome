import { useSyncExternalStore } from "react";
import { Controller } from "../shinonome/controller";
import { AppBar, Footer } from "./Brand";
import { Desktop } from "./Desktop";
import { Setup } from "./Setup";

// Only one, because it listens for USB and page events for as long as the page is open.
const controller = new Controller();

export function App() {
	const state = useSyncExternalStore(controller.subscribe, controller.getState);
	if (state.step === "live") {
		return <Desktop controller={controller} state={state} />;
	}
	return (
		<div className="app">
			<AppBar logo="./logo.webp" />
			<Setup controller={controller} state={state} />
			<Footer />
		</div>
	);
}
