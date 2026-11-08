package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.hardware.input.InputManager;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Injects mouse and keyboard events into one display. Callers synchronize on the instance. */
final class Input {

	static final int MOUSE_MOVE = 0;
	static final int MOUSE_PRESS = 1;
	static final int MOUSE_RELEASE = 2;

	private static final int INJECT_MODE_ASYNC = 0;
	private static final int[] BUTTONS = {
		MotionEvent.BUTTON_PRIMARY, MotionEvent.BUTTON_SECONDARY, MotionEvent.BUTTON_TERTIARY,
	};

	private final InputManager manager;
	private final Method injectInputEvent;
	private final Method setDisplayId;
	private final Method setActionButton;
	private final int displayId;

	private final MotionEvent.PointerProperties[] properties = {new MotionEvent.PointerProperties()};
	private final MotionEvent.PointerCoords[] coords = {new MotionEvent.PointerCoords()};
	private final Map<Integer, KeyState> keys = new HashMap<>();

	private int buttons;
	private int meta;
	private long downTime;
	private float x;
	private float y;

	Input(Context context, int displayId) throws ReflectiveOperationException {
		this.displayId = displayId;
		manager = (InputManager) context.getSystemService(Context.INPUT_SERVICE);
		injectInputEvent = InputManager.class.getMethod("injectInputEvent", InputEvent.class, int.class);
		setDisplayId = InputEvent.class.getMethod("setDisplayId", int.class);
		setActionButton = MotionEvent.class.getMethod("setActionButton", int.class);
		properties[0].id = 0;
		properties[0].toolType = MotionEvent.TOOL_TYPE_MOUSE;
	}

	void mouse(int action, int button, int newX, int newY) {
		x = newX;
		y = newY;
		switch (action) {
			case MOUSE_MOVE:
				injectMotion(buttons == 0 ? MotionEvent.ACTION_HOVER_MOVE : MotionEvent.ACTION_MOVE, 0, 0, 0);
				break;
			case MOUSE_PRESS:
				press(button);
				break;
			case MOUSE_RELEASE:
				release(button);
				break;
			default:
				break;
		}
	}

	void scroll(int newX, int newY, float horizontal, float vertical) {
		x = newX;
		y = newY;
		injectMotion(MotionEvent.ACTION_SCROLL, 0, horizontal, vertical);
	}

	void key(int action, int code, int metaState) {
		meta = metaState;
		long now = SystemClock.uptimeMillis();
		KeyState state = keys.get(code);
		if (action == KeyEvent.ACTION_DOWN) {
			if (state == null) {
				state = new KeyState(now);
				keys.put(code, state);
			} else {
				state.repeat++;
			}
		} else {
			if (state == null) {
				return;
			}
			keys.remove(code);
		}
		injectKey(state.downTime, now, action, code, action == KeyEvent.ACTION_DOWN ? state.repeat : 0, metaState);
	}

	/** Lifts everything still held, so a dropped connection cannot leave a stuck button or key. */
	void releaseAll() {
		for (int button : BUTTONS) {
			if ((buttons & button) != 0) {
				release(button);
			}
		}
		List<Integer> held = new ArrayList<>(keys.keySet());
		for (int code : held) {
			key(KeyEvent.ACTION_UP, code, 0);
		}
		meta = 0;
	}

	/** For events that are already complete, such as those from the phone's own touchscreen. */
	void injectRaw(InputEvent event, int actionButton) {
		try {
			if (actionButton != 0 && event instanceof MotionEvent) {
				setActionButton.invoke(event, actionButton);
			}
			inject(event);
		} catch (ReflectiveOperationException e) {
			Log.error("input injection failed", e);
		}
	}

	private void press(int button) {
		if ((buttons & button) != 0) {
			return;
		}
		boolean first = buttons == 0;
		buttons |= button;
		if (first) {
			downTime = SystemClock.uptimeMillis();
			injectMotion(MotionEvent.ACTION_DOWN, 0, 0, 0);
		}
		injectMotion(MotionEvent.ACTION_BUTTON_PRESS, button, 0, 0);
	}

	private void release(int button) {
		if ((buttons & button) == 0) {
			return;
		}
		buttons &= ~button;
		injectMotion(MotionEvent.ACTION_BUTTON_RELEASE, button, 0, 0);
		if (buttons == 0) {
			injectMotion(MotionEvent.ACTION_UP, 0, 0, 0);
		}
	}

	private void injectMotion(int action, int actionButton, float horizontal, float vertical) {
		long now = SystemClock.uptimeMillis();
		MotionEvent.PointerCoords c = coords[0];
		c.clear();
		c.x = x;
		c.y = y;
		c.pressure = buttons != 0 ? 1f : 0f;
		c.size = 1f;
		if (action == MotionEvent.ACTION_SCROLL) {
			c.setAxisValue(MotionEvent.AXIS_HSCROLL, horizontal);
			c.setAxisValue(MotionEvent.AXIS_VSCROLL, vertical);
		}
		boolean hover = action == MotionEvent.ACTION_HOVER_MOVE || action == MotionEvent.ACTION_SCROLL;
		MotionEvent event = MotionEvent.obtain(hover ? now : downTime, now, action, 1, properties, coords, meta,
				buttons, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0);
		try {
			if (actionButton != 0) {
				setActionButton.invoke(event, actionButton);
			}
			inject(event);
		} catch (ReflectiveOperationException e) {
			Log.error("mouse injection failed", e);
		} finally {
			event.recycle();
		}
	}

	private void injectKey(long down, long now, int action, int code, int repeat, int metaState) {
		KeyEvent event = new KeyEvent(down, now, action, code, repeat, metaState,
				KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
		try {
			inject(event);
		} catch (ReflectiveOperationException e) {
			Log.error("key injection failed", e);
		}
	}

	private void inject(InputEvent event) throws ReflectiveOperationException {
		setDisplayId.invoke(event, displayId);
		injectInputEvent.invoke(manager, event, INJECT_MODE_ASYNC);
	}

	private static final class KeyState {
		final long downTime;
		int repeat;

		KeyState(long downTime) {
			this.downTime = downTime;
		}
	}
}
