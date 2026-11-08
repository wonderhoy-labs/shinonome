import { type SoundState, toggleFullscreen } from "@wonderhoy-labs/shinonome";
import { useEffect, useRef, useState } from "react";
import type { Controller, ShinonomeState } from "../shinonome/controller";

interface Props {
	controller: Controller;
	state: ShinonomeState;
}

function useIsFullscreen(): boolean {
	const [fullscreen, setFullscreen] = useState(false);
	useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement !== null);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);
	return fullscreen;
}

/** Whether files are being dragged over the element, which hands any dropped there to onDrop. */
function useFileDrop(
	element: React.RefObject<HTMLElement | null>,
	enabled: boolean,
	onDrop: (files: File[]) => void,
): boolean {
	const [dragging, setDragging] = useState(false);
	const latest = useRef({ enabled, onDrop });
	latest.current = { enabled, onDrop };
	useEffect(() => {
		const target = element.current;
		if (!target) {
			return;
		}
		const listeners = new AbortController();
		const { signal } = listeners;
		target.addEventListener(
			"dragover",
			(event) => {
				if (latest.current.enabled && event.dataTransfer?.types.includes("Files")) {
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
					setDragging(true);
				}
			},
			{ signal },
		);
		target.addEventListener(
			"dragleave",
			(event) => {
				if (!target.contains(event.relatedTarget as Node | null)) {
					setDragging(false);
				}
			},
			{ signal },
		);
		target.addEventListener(
			"drop",
			(event) => {
				event.preventDefault();
				setDragging(false);
				latest.current.onDrop(Array.from(event.dataTransfer?.files ?? []));
			},
			{ signal },
		);
		return () => listeners.abort();
	}, [element]);
	return dragging;
}

/** Always dark, because the desktop sits on black and anything bright pulls your eye away from it. */
export function Desktop({ controller, state }: Props) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const fullscreen = useIsFullscreen();
	const area = useRef<HTMLDivElement>(null);
	const dragging = useFileDrop(area, state.link === "up", (files) => void controller.saveToPhone(files));

	useEffect(() => {
		if (canvas.current) {
			controller.attachCanvas(canvas.current);
		}
		return () => controller.releaseCanvas();
	}, [controller]);

	return (
		<main className="desktop mdui-theme-dark">
			{/* Fullscreen is all desktop. The browser says how to leave, by holding Esc. */}
			{fullscreen ? null : <TopBar controller={controller} state={state} canvas={canvas} />}
			<div className="screen-area" ref={area}>
				<canvas id="screen" ref={canvas} width={1920} height={1080} tabIndex={0} aria-label="Phone desktop" />
				{dragging ? (
					<ScreenNote text="Drop to save in your phone's Downloads." icon={<mdui-icon-upload-file />} />
				) : (
					<ScreenMessage controller={controller} state={state} />
				)}
			</div>
		</main>
	);
}

function statusText({ link, phone }: ShinonomeState): string {
	if (link === "phone-lost") {
		return "Disconnected";
	}
	return link === "up" ? (phone ?? "Connected") : "Connecting…";
}

const SOUND_LABELS: Record<SoundState, string> = {
	off: "Sound plays on your phone. Play it here",
	"needs-click": "Click to let this page play your phone's sound",
	starting: "Moving the sound here",
	on: "Sound plays here. Move it back to your phone",
	failed: "Your phone wouldn't share its sound",
};

const SHARP_LABEL_ON =
	"Sharp mode is on: the desktop uses your phone's density, which apps like Discord need. Turn it off for the lowest latency";
const SHARP_LABEL_OFF =
	"Sharp mode: use your phone's density, which apps like Discord need, at a little more latency. Reopen those apps after switching";

function TopBar({ controller, state, canvas }: Props & { canvas: React.RefObject<HTMLCanvasElement | null> }) {
	const { link, stats, sound, sharp } = state;
	return (
		<header className="top-bar">
			<img className="top-bar-logo" src="./logo.webp" alt="" />
			<span className={`top-bar-light top-bar-light-${link}`} aria-hidden="true" />
			<span className="top-bar-status">{statusText(state)}</span>
			<span className="top-bar-space" />
			{stats && link === "up" ? (
				<span className="top-bar-stats">
					{stats.fps} fps · {stats.megabits.toFixed(1)} Mbit/s ·{" "}
					{stats.latencyMs === null ? "–" : `${stats.latencyMs.toFixed(0)} ms`}
				</span>
			) : null}
			{/* Plain titles, because the bar goes away while the pointer's on these and an mdui tooltip can't cope. */}
			<mdui-button-icon
				id="sound"
				title={SOUND_LABELS[sound]}
				aria-label={SOUND_LABELS[sound]}
				onClick={() => controller.toggleSound()}
			>
				{sound === "on" || sound === "starting" ? <mdui-icon-volume-up /> : <mdui-icon-volume-off />}
			</mdui-button-icon>
			<mdui-button-icon
				id="sharp"
				title={sharp ? SHARP_LABEL_ON : SHARP_LABEL_OFF}
				aria-label={sharp ? SHARP_LABEL_ON : SHARP_LABEL_OFF}
				variant={sharp ? "tonal" : "standard"}
				onClick={() => controller.toggleSharp()}
			>
				<mdui-icon-hd />
			</mdui-button-icon>
			<mdui-button-icon
				id="fullscreen"
				title="Fullscreen"
				aria-label="Fullscreen"
				onClick={() => {
					if (canvas.current) {
						void toggleFullscreen(canvas.current);
					}
				}}
			>
				<mdui-icon-fullscreen />
			</mdui-button-icon>
			<mdui-button id="end-session" variant="text" onClick={() => controller.endSession()}>
				<mdui-icon-power-settings-new slot="icon" />
				End session
			</mdui-button>
		</header>
	);
}

function ScreenMessage({ controller, state }: Props) {
	const { link, status, hasPicture } = state;
	if (link === "phone-lost") {
		return (
			<div className="screen-card" role="alert">
				<mdui-icon-usb />
				<h2>Your phone was disconnected</h2>
				<p>Plug it back in and this carries on by itself. Your session waits for two minutes.</p>
				<div className="actions">
					<mdui-button variant="filled" onClick={() => void controller.connectUsb()}>
						Connect phone
					</mdui-button>
					<mdui-button variant="text" onClick={() => controller.endSession()}>
						Leave
					</mdui-button>
				</div>
			</div>
		);
	}
	if (status && !status.usable) {
		return <ScreenNote text="Your phone is locked. Unlock it to continue." icon={<mdui-icon-lock />} />;
	}
	if (link === "connecting") {
		return <ScreenNote text="Connecting to your phone." icon={<mdui-circular-progress />} />;
	}
	if (status && !status.desktop) {
		return (
			<ScreenNote
				text="This phone did not make the display a desktop, so windows may not behave as expected."
				icon={<mdui-icon-error-outline />}
			/>
		);
	}
	if (!hasPicture) {
		return <ScreenNote text="Waiting for the first picture." icon={<mdui-circular-progress />} />;
	}
	if (state.transfer) {
		return (
			<ScreenNote
				text={`Sending ${state.transfer.name} to your phone… ${state.transfer.percent}%`}
				icon={<mdui-circular-progress value={state.transfer.percent / 100} />}
			/>
		);
	}
	if (state.transferNote) {
		return <ScreenNote text={state.transferNote} icon={<mdui-icon-upload-file />} />;
	}
	return null;
}

/** Doesn't take clicks, so the desktop underneath stays usable. */
function ScreenNote({ text, icon }: { text: string; icon: React.ReactNode }) {
	return (
		<div className="screen-note" role="status">
			{icon}
			<span>{text}</span>
		</div>
	);
}
