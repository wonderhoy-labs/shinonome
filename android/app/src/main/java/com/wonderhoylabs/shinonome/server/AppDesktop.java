package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.view.Display;
import android.view.InputEvent;
import android.view.Surface;

import java.io.IOException;

/**
 * The desktop shown inside the phone's own app. The display draws straight onto the app's surface,
 * so there is no encoding or network in the way. Runs as the shell user in the Shizuku service.
 */
public final class AppDesktop {

	private static final int ADOPT_ATTEMPTS = 15;
	private static final int ADOPT_WAIT_MS = 100;

	private final Context context;
	private VirtualDisplay display;
	private IdleSurface idleSurface;
	private Input input;
	private int width;
	private int height;
	private int dpi;

	public AppDesktop() throws ReflectiveOperationException {
		context = Hidden.currentShellContext();
	}

	/** Shows the desktop on this surface, creating it if needed. Returns the display ID. */
	public synchronized int attach(Surface surface, int newWidth, int newHeight, int newDpi) {
		if (display == null) {
			// Binder only passes runtime exceptions back to the app, which shows the message.
			String problem = DesktopDisplay.incompatibility(context);
			if (problem != null) {
				throw new IllegalStateException(problem);
			}
			try {
				DisplayManager manager = DesktopDisplay.manager(context);
				// Without these flags, locking the phone hides every window and starts a new home screen.
				display = DesktopDisplay.create(manager, DesktopDisplay.ID_APP, newWidth, newHeight, newDpi,
						DesktopDisplay.FLAGS_KEEP_RUNNING_LOCKED, surface);
				int id = display.getDisplay().getDisplayId();
				input = new Input(context, id);
				// Phones have no physical keyboard, so show the on-screen one over the app.
				Hidden.setImePolicy(id, Hidden.DISPLAY_IME_POLICY_FALLBACK_DISPLAY);
			} catch (IOException | ReflectiveOperationException e) {
				throw new IllegalStateException("Android refused to create the desktop: " + e, e);
			}
		} else {
			if (newWidth != width || newHeight != height || newDpi != dpi) {
				display.resize(newWidth, newHeight, newDpi);
			}
			display.setSurface(surface);
		}
		width = newWidth;
		height = newHeight;
		dpi = newDpi;
		return display.getDisplay().getDisplayId();
	}

	/** Whether Android treats the current display as a desktop. */
	public synchronized boolean isEligible() {
		return display != null && Hidden.isEligibleForDesktopMode(display.getDisplay().getDisplayId());
	}

	/** The app went away, but its windows keep running on a placeholder until it comes back. */
	public synchronized void detach() {
		if (display == null) {
			return;
		}
		if (idleSurface == null) {
			idleSurface = new IdleSurface();
		}
		display.setSurface(idleSurface.surface());
	}

	/** Ends the desktop. Android moves its windows back to the phone. */
	public synchronized void end() {
		if (display != null) {
			try {
				display.release();
			} catch (RuntimeException e) {
				Log.error("could not release the display", e);
			}
			display = null;
			input = null;
		}
	}

	/**
	 * Called when the desktop's app loses the foreground. If an ordinary app took over the phone's
	 * screen, such as one opened from a notification, moves it into the desktop instead, where it
	 * gets a title bar. Going home or to recents is left alone, so the phone stays usable.
	 *
	 * @return whether an app was moved, in which case the desktop's app should come back to the front
	 */
	public boolean adoptForegroundApp(String desktopActivity) {
		int displayId;
		synchronized (this) {
			if (display == null) {
				return false;
			}
			displayId = display.getDisplay().getDisplayId();
		}
		// This app's own screen stays on the phone, or its controls would vanish into the desktop.
		String ownPackage = desktopActivity.substring(0, desktopActivity.indexOf('/') + 1);
		for (int attempt = 0; attempt < ADOPT_ATTEMPTS; attempt++) {
			Hidden.ForegroundTask task = Hidden.foregroundTask();
			if (task != null && !desktopActivity.equals(task.activity)) {
				if (task.displayId != Display.DEFAULT_DISPLAY || !task.isOrdinaryApp
						|| task.activity.startsWith(ownPackage)) {
					return false;
				}
				Log.info("moving " + task.activity + " into the desktop");
				return Hidden.moveTaskToDisplay(task.taskId, displayId);
			}
			try {
				Thread.sleep(ADOPT_WAIT_MS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return false;
			}
		}
		return false;
	}

	public synchronized void injectEvent(InputEvent event, int actionButton) {
		if (input != null) {
			input.injectRaw(event, actionButton);
		}
	}
}
