package com.wonderhoylabs.shinonome.server;

import android.app.ActivityOptions;
import android.app.Application;
import android.app.Instrumentation;
import android.content.AttributionSource;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.IBinder;
import android.os.SystemClock;
import android.view.Display;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * Non-SDK Android calls, all made through reflection.
 *
 * Process setup is adapted from scrcpy's Workarounds and FakeContext (Apache-2.0).
 */
final class Hidden {

	private static final String WINDOW_MANAGER_STUB = "android.view.IWindowManager$Stub";
	private static final String ACTIVITY_TASK_SERVICE = "activity_task";
	private static final String ACTIVITY_TASK_MANAGER_STUB = "android.app.IActivityTaskManager$Stub";
	private static final String SYSTEM_UI_PACKAGE = "com.android.systemui";
	private static final int ACTIVITY_TYPE_STANDARD = 1;
	private static final int MAX_TASKS = 100;
	private static final String POWER_MANAGER_STUB = "android.os.IPowerManager$Stub";
	private static final int WAKE_REASON_APPLICATION = 2;
	private static final String SHELL_PACKAGE = "com.android.shell";
	static final int SHELL_UID = 2000;
	private static final int USER_ACTIVITY_EVENT_OTHER = 0;
	/** Shows the on-screen keyboard on the phone's own screen instead of on the desktop. */
	static final int DISPLAY_IME_POLICY_FALLBACK_DISPLAY = 1;
	/** Never shows it. Remote clients have a real keyboard, and it would cover the desktop. */
	static final int DISPLAY_IME_POLICY_HIDE = 2;

	private Hidden() {
	}

	/** Turns a display's panel on or off without changing whether the system considers it awake. */
	static boolean requestDisplayPower(int displayId, boolean on) {
		try {
			Object manager = service(Context.DISPLAY_SERVICE, "android.hardware.display.IDisplayManager$Stub");
			Method method = manager.getClass().getMethod("requestDisplayPower", int.class, int.class);
			int state = on ? Display.STATE_ON : Display.STATE_OFF;
			return (boolean) method.invoke(manager, displayId, state);
		} catch (ReflectiveOperationException e) {
			Log.error("requestDisplayPower failed", e);
			return false;
		}
	}

	/** Reports locked if the check fails, because input must never reach a phone that might be locked. */
	static boolean isKeyguardLocked() {
		try {
			Object windowManager = service(Context.WINDOW_SERVICE, WINDOW_MANAGER_STUB);
			return (boolean) windowManager.getClass().getMethod("isKeyguardLocked").invoke(windowManager);
		} catch (ReflectiveOperationException e) {
			Log.error("isKeyguardLocked failed", e);
			return true;
		}
	}

	/** Whether Android treats this display as able to host a desktop, windowing and all. */
	static boolean isEligibleForDesktopMode(int displayId) {
		try {
			Object windowManager = service(Context.WINDOW_SERVICE, WINDOW_MANAGER_STUB);
			return (boolean) windowManager.getClass().getMethod("isEligibleForDesktopMode", int.class)
					.invoke(windowManager, displayId);
		} catch (ReflectiveOperationException e) {
			Log.error("isEligibleForDesktopMode failed", e);
			return false;
		}
	}

	/** Reports awake if the check fails, so a failure cannot cause a wake loop. */
	static boolean isInteractive() {
		try {
			Object power = service(Context.POWER_SERVICE, POWER_MANAGER_STUB);
			return (boolean) power.getClass().getMethod("isDisplayInteractive", int.class)
					.invoke(power, Display.DEFAULT_DISPLAY);
		} catch (ReflectiveOperationException e) {
			Log.error("isDisplayInteractive failed", e);
			return true;
		}
	}

	static void wakeUp() {
		try {
			Object power = service(Context.POWER_SERVICE, POWER_MANAGER_STUB);
			power.getClass().getMethod("wakeUp", long.class, int.class, String.class, String.class)
					.invoke(power, SystemClock.uptimeMillis(), WAKE_REASON_APPLICATION, "shinonome", SHELL_PACKAGE);
		} catch (ReflectiveOperationException e) {
			Log.error("wakeUp failed", e);
		}
	}

	/** What is in the foreground of the focused display. */
	static final class ForegroundTask {
		final int taskId;
		final int displayId;
		final String activity;
		final boolean isOrdinaryApp;

		ForegroundTask(int taskId, int displayId, String activity, boolean isOrdinaryApp) {
			this.taskId = taskId;
			this.displayId = displayId;
			this.activity = activity;
			this.isOrdinaryApp = isOrdinaryApp;
		}
	}

	/** A task on a display: the app in front of it, and where its window is. */
	static final class DisplayTask {
		final int taskId;
		final String packageName;
		/** Null if the window's bounds couldn't be read. */
		final Rect bounds;

		DisplayTask(int taskId, String packageName, Rect bounds) {
			this.taskId = taskId;
			this.packageName = packageName;
			this.bounds = bounds;
		}
	}

	/**
	 * The app tasks on a display, including those behind other windows and inside desktop desks, which are root
	 * tasks of their own. Empty if they can't be read.
	 */
	static List<DisplayTask> tasksOnDisplay(int displayId) {
		List<DisplayTask> found = new ArrayList<>();
		try {
			Object tasks = service(ACTIVITY_TASK_SERVICE, ACTIVITY_TASK_MANAGER_STUB);
			List<?> infos = null;
			for (Method method : tasks.getClass().getMethods()) {
				Class<?>[] types = method.getParameterTypes();
				if (method.getName().equals("getTasks") && types.length == 4 && types[0] == int.class
						&& types[1] == boolean.class && types[2] == boolean.class && types[3] == int.class) {
					infos = (List<?>) method.invoke(tasks, MAX_TASKS, false, false, displayId);
					break;
				}
			}
			if (infos == null) {
				Log.info("could not list the desktop's tasks on this Android version");
				return found;
			}
			for (Object info : infos) {
				Class<?> type = info.getClass();
				ComponentName top = (ComponentName) type.getField("topActivity").get(info);
				if (top == null || type.getField("displayId").getInt(info) != displayId) {
					continue;
				}
				found.add(new DisplayTask(type.getField("taskId").getInt(info), top.getPackageName(),
						windowBounds((Configuration) type.getField("configuration").get(info))));
			}
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.error("could not list the desktop's tasks", e);
		}
		return found;
	}

	private static Rect windowBounds(Configuration configuration) {
		try {
			Object window = Configuration.class.getField("windowConfiguration").get(configuration);
			Rect bounds = (Rect) window.getClass().getMethod("getBounds").invoke(window);
			return bounds == null || bounds.isEmpty() ? null : new Rect(bounds);
		} catch (ReflectiveOperationException | RuntimeException e) {
			return null;
		}
	}

	static ForegroundTask foregroundTask() {
		try {
			Object tasks = service(ACTIVITY_TASK_SERVICE, ACTIVITY_TASK_MANAGER_STUB);
			Object info = tasks.getClass().getMethod("getFocusedRootTaskInfo").invoke(tasks);
			if (info == null) {
				return null;
			}
			Class<?> type = info.getClass();
			ComponentName top = (ComponentName) type.getField("topActivity").get(info);
			if (top == null) {
				return null;
			}
			int activityType = type.getField("topActivityType").getInt(info);
			boolean ordinary = activityType == ACTIVITY_TYPE_STANDARD
					&& !SYSTEM_UI_PACKAGE.equals(top.getPackageName());
			return new ForegroundTask(type.getField("taskId").getInt(info),
					type.getField("displayId").getInt(info), top.flattenToString(), ordinary);
		} catch (ReflectiveOperationException e) {
			Log.error("could not read the foreground task", e);
			return null;
		}
	}

	/** Asks for the task the way Android's own recents does, so the desktop manager adopts it. */
	static boolean moveTaskToDisplay(int taskId, int displayId) {
		try {
			Bundle options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle();
			Object tasks = service(ACTIVITY_TASK_SERVICE, ACTIVITY_TASK_MANAGER_STUB);
			tasks.getClass().getMethod("startActivityFromRecents", int.class, Bundle.class)
					.invoke(tasks, taskId, options);
			return true;
		} catch (ReflectiveOperationException e) {
			Log.error("could not move the task", e);
			return false;
		}
	}

	static void setImePolicy(int displayId, int policy) {
		try {
			Object windowManager = service(Context.WINDOW_SERVICE, WINDOW_MANAGER_STUB);
			windowManager.getClass().getMethod("setDisplayImePolicy", int.class, int.class)
					.invoke(windowManager, displayId, policy);
		} catch (ReflectiveOperationException e) {
			Log.error("could not set the on-screen keyboard policy", e);
		}
	}

	/** Stops the phone timing out while a client is connected. */
	static void userActivity(int displayId) {
		try {
			Object power = service(Context.POWER_SERVICE, POWER_MANAGER_STUB);
			power.getClass().getMethod("userActivity", int.class, long.class, int.class, int.class)
					.invoke(power, displayId, SystemClock.uptimeMillis(), USER_ACTIVITY_EVENT_OTHER, 0);
		} catch (ReflectiveOperationException e) {
			Log.error("userActivity failed", e);
		}
	}

	static Object service(String name, String stubClass) throws ReflectiveOperationException {
		Object binder = Class.forName("android.os.ServiceManager")
				.getMethod("getService", String.class).invoke(null, name);
		return Class.forName(stubClass).getMethod("asInterface", IBinder.class).invoke(null, binder);
	}

	/** For a process that already has an ActivityThread, such as the Shizuku service. */
	static Context currentShellContext() throws ReflectiveOperationException {
		Class<?> threadClass = Class.forName("android.app.ActivityThread");
		Object thread = threadClass.getMethod("currentActivityThread").invoke(null);
		return new ShellContext((Context) threadClass.getMethod("getSystemContext").invoke(thread));
	}

	static Context createShellContext() throws ReflectiveOperationException {
		Class<?> threadClass = Class.forName("android.app.ActivityThread");
		Constructor<?> threadCtor = threadClass.getDeclaredConstructor();
		threadCtor.setAccessible(true);
		Object thread = threadCtor.newInstance();
		setField(threadClass, null, "sCurrentActivityThread", thread);
		setField(threadClass, thread, "mSystemThread", true);

		Class<?> controllerClass = Class.forName("android.app.ConfigurationController");
		Constructor<?> controllerCtor = controllerClass.getDeclaredConstructor(
				Class.forName("android.app.ActivityThreadInternal"));
		controllerCtor.setAccessible(true);
		setField(threadClass, thread, "mConfigurationController", controllerCtor.newInstance(thread));

		Class<?> bindDataClass = Class.forName("android.app.ActivityThread$AppBindData");
		Constructor<?> bindDataCtor = bindDataClass.getDeclaredConstructor();
		bindDataCtor.setAccessible(true);
		Object bindData = bindDataCtor.newInstance();
		ApplicationInfo appInfo = new ApplicationInfo();
		appInfo.packageName = SHELL_PACKAGE;
		setField(bindDataClass, bindData, "appInfo", appInfo);
		setField(threadClass, thread, "mBoundApplication", bindData);

		Method getSystemContext = threadClass.getDeclaredMethod("getSystemContext");
		getSystemContext.setAccessible(true);
		Context shell = new ShellContext((Context) getSystemContext.invoke(thread));
		Application application = Instrumentation.newApplication(Application.class, shell);
		setField(threadClass, thread, "mInitialApplication", application);
		return shell;
	}

	private static void setField(Class<?> owner, Object target, String name, Object value)
			throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	private static final class ShellContext extends ContextWrapper {
		ShellContext(Context base) {
			super(base);
		}

		@Override
		public String getPackageName() {
			return SHELL_PACKAGE;
		}

		@Override
		public String getOpPackageName() {
			return SHELL_PACKAGE;
		}

		@Override
		public AttributionSource getAttributionSource() {
			return new AttributionSource.Builder(SHELL_UID).setPackageName(SHELL_PACKAGE).build();
		}

		@Override
		public int getDeviceId() {
			return 0;
		}

		@Override
		public Context getApplicationContext() {
			return this;
		}
	}
}
