package com.wonderhoylabs.shinonome.server;

import android.content.ClipData;
import android.content.Context;
import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;
import android.os.Parcel;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * The phone's clipboard, through the clipboard service as the shell user. The public ClipboardManager would name
 * the system context's package, which the service refuses from the shell user.
 *
 * Every Android version adds arguments, such as an attribution tag or a device ID, so methods are found by name and
 * their arguments filled by type: the first string is the calling package, any other is null, and every int is 0,
 * the owner's user and the default device.
 */
final class Clipboard {

	private static final String SHELL_PACKAGE = "com.android.shell";
	private static final String LISTENER = "android.content.IOnPrimaryClipChangedListener";
	private static final String LABEL = "Shinonome";

	private final Object service;
	private final Method getPrimaryClip;
	private final Method setPrimaryClip;
	private final Context context;
	// Held so the service's link to it stays alive.
	private Binder listener;

	private Clipboard(Context context, Object service) throws ReflectiveOperationException {
		this.context = context;
		this.service = service;
		getPrimaryClip = find(service, "getPrimaryClip", null);
		setPrimaryClip = find(service, "setPrimaryClip", ClipData.class);
	}

	static Clipboard open(Context context) throws ReflectiveOperationException {
		return new Clipboard(context, Hidden.service("clipboard", "android.content.IClipboard$Stub"));
	}

	/** The clipboard's text, or null if it holds something else or the phone is locked. */
	String text() {
		try {
			ClipData clip = (ClipData) getPrimaryClip.invoke(service, arguments(getPrimaryClip, null));
			if (clip == null || clip.getItemCount() == 0) {
				return null;
			}
			CharSequence text = clip.getItemAt(0).coerceToText(context);
			return text == null || text.length() == 0 ? null : text.toString();
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.info("could not read the clipboard: " + e);
			return null;
		}
	}

	boolean setText(String text) {
		try {
			setPrimaryClip.invoke(service, arguments(setPrimaryClip, ClipData.newPlainText(LABEL, text)));
			return true;
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.info("could not set the clipboard: " + e);
			return false;
		}
	}

	/** Runs onChange on a binder thread whenever anything on the phone changes the clipboard. */
	void listen(Runnable onChange) throws ReflectiveOperationException {
		Class<?> type = Class.forName(LISTENER);
		Binder binder = new Binder() {
			@Override
			protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
					throws android.os.RemoteException {
				// The interface's only method, dispatchPrimaryClipChanged.
				if (code == IBinder.FIRST_CALL_TRANSACTION) {
					onChange.run();
					return true;
				}
				return super.onTransact(code, data, reply, flags);
			}
		};
		Object proxy = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (self, method, args) -> {
			switch (method.getName()) {
				case "asBinder":
					return binder;
				case "dispatchPrimaryClipChanged":
					onChange.run();
					return null;
				case "hashCode":
					return System.identityHashCode(self);
				case "equals":
					return self == args[0];
				default:
					return "clipboard listener";
			}
		});
		binder.attachInterface((IInterface) proxy, LISTENER);
		Method add = find(service, "addPrimaryClipChangedListener", type);
		add.invoke(service, arguments(add, proxy));
		listener = binder;
	}

	private static Method find(Object target, String name, Class<?> first) throws NoSuchMethodException {
		for (Method method : target.getClass().getMethods()) {
			if (!method.getName().equals(name)) {
				continue;
			}
			Class<?>[] types = method.getParameterTypes();
			int start = first == null ? 0 : 1;
			if (first != null && (types.length == 0 || types[0] != first)) {
				continue;
			}
			boolean fits = true;
			for (int i = start; i < types.length; i++) {
				fits &= types[i] == String.class || types[i] == int.class;
			}
			if (fits) {
				return method;
			}
		}
		throw new NoSuchMethodException(name);
	}

	private static Object[] arguments(Method method, Object first) {
		Class<?>[] types = method.getParameterTypes();
		Object[] values = new Object[types.length];
		int start = 0;
		if (first != null) {
			values[0] = first;
			start = 1;
		}
		boolean namedPackage = false;
		for (int i = start; i < types.length; i++) {
			if (types[i] == int.class) {
				values[i] = 0;
			} else if (!namedPackage) {
				values[i] = SHELL_PACKAGE;
				namedPackage = true;
			}
		}
		return values;
	}
}
