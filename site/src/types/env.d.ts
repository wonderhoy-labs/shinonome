/// <reference types="mdui/jsx.en.d.ts" />
import type React from 'react';

type IconProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { slot?: string };

declare global {
  /** The version of the APK this site carries. */
  const __SHINONOME_VERSION__: string;
  const __SHINONOME_VERSION_CODE__: number;

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        [icon: `mdui-icon-${string}`]: IconProps;
      }
    }
  }
}
