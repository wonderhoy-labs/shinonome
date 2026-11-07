const META_SHIFT = 0x41;
const META_ALT = 0x12;
const META_CTRL = 0x3000;
const META_SYSTEM = 0x30000;

const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_CTRL_RIGHT = 114;
const KEYCODE_META_LEFT = 117;

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** KeyboardEvent.code to Android's KeyEvent.KEYCODE_*. */
const KEYCODES: Record<string, number> = {
  Digit0: 7, Digit1: 8, Digit2: 9, Digit3: 10, Digit4: 11, Digit5: 12, Digit6: 13, Digit7: 14, Digit8: 15, Digit9: 16,
  KeyA: 29, KeyB: 30, KeyC: 31, KeyD: 32, KeyE: 33, KeyF: 34, KeyG: 35, KeyH: 36, KeyI: 37, KeyJ: 38, KeyK: 39,
  KeyL: 40, KeyM: 41, KeyN: 42, KeyO: 43, KeyP: 44, KeyQ: 45, KeyR: 46, KeyS: 47, KeyT: 48, KeyU: 49, KeyV: 50,
  KeyW: 51, KeyX: 52, KeyY: 53, KeyZ: 54,
  Comma: 55, Period: 56, Tab: 61, Space: 62, Enter: 66, Backspace: 67, Backquote: 68, Minus: 69, Equal: 70,
  BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75, Slash: 76,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  PageUp: 92, PageDown: 93, Escape: 111, Delete: 112, CapsLock: 115, Home: 122, End: 123, Insert: 124,
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
  ShiftLeft: 59, ShiftRight: 60, AltLeft: 57, AltRight: 58,
  Numpad0: 144, Numpad1: 145, Numpad2: 146, Numpad3: 147, Numpad4: 148, Numpad5: 149, Numpad6: 150, Numpad7: 151,
  Numpad8: 152, Numpad9: 153, NumpadDivide: 154, NumpadMultiply: 155, NumpadSubtract: 156, NumpadAdd: 157,
  NumpadDecimal: 158, NumpadEnter: 160, NumpadEqual: 161,
  // Android shortcuts use Ctrl where a Mac uses Cmd, so Cmd sends Ctrl there and Control reaches the system key.
  ControlLeft: isMac ? KEYCODE_META_LEFT : KEYCODE_CTRL_LEFT,
  ControlRight: isMac ? KEYCODE_META_LEFT : KEYCODE_CTRL_RIGHT,
  MetaLeft: isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT,
  MetaRight: isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT,
};

export function keycodeFor(code: string): number | undefined {
  return KEYCODES[code];
}

export function metaState(event: KeyboardEvent): number {
  let meta = 0;
  if (event.shiftKey) {
    meta |= META_SHIFT;
  }
  if (event.altKey) {
    meta |= META_ALT;
  }
  if (event.metaKey) {
    meta |= isMac ? META_CTRL : META_SYSTEM;
  }
  if (event.ctrlKey) {
    meta |= isMac ? META_SYSTEM : META_CTRL;
  }
  return meta;
}
