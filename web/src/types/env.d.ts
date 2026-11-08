/// <reference types="mdui/jsx.en.d.ts" />
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type IconProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { slot?: string };

// mdui types its components for JSX, but not the icons from @mdui/icons.
declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			[icon: `mdui-icon-${string}`]: IconProps;
		}
	}
}

declare global {
	/** The version of the APK this site carries. */
	const __SHINONOME_VERSION__: string;
	const __SHINONOME_VERSION_CODE__: number;
}
