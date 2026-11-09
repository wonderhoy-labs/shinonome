package com.wonderhoylabs.shinonome.server;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Which apps need the desktop to have the phone's density.
 *
 * React Native lays out with the density of the phone's own screen, whatever display its window is on. On a desktop
 * with another density its screens come apart: Discord shows a wide blank strip in the middle and runs off the right
 * edge, even when started fresh on the desktop. Sharp mode gives the desktop the phone's density, which puts it right.
 * These apps are told apart by React Native's native library in their APK.
 */
final class DensityNeeds {

	private static final String[] LIBRARIES = {"libreactnative.so", "libreactnativejni.so"};

	private final PackageManager packages;
	// By the APK's path, which changes whenever the app is updated.
	private final Map<String, Boolean> known = new HashMap<>();

	DensityNeeds(Context context) {
		packages = context.getPackageManager();
	}

	/** Whether the app lays out with the phone's density. False for an app that can't be read. */
	synchronized boolean needsPhoneDensity(String packageName) {
		ApplicationInfo info = info(packageName);
		if (info == null || info.sourceDir == null) {
			return false;
		}
		Boolean needs = known.get(info.sourceDir);
		if (needs == null) {
			needs = usesReactNative(info);
			known.put(info.sourceDir, needs);
			if (needs) {
				Log.info(packageName + " uses React Native, so it needs sharp mode on the desktop");
			}
		}
		return needs;
	}

	/** The app's name, as the launcher shows it. */
	String label(String packageName) {
		ApplicationInfo info = info(packageName);
		return info == null ? packageName : packages.getApplicationLabel(info).toString();
	}

	/** The activity its launcher icon opens, or null if it has none. */
	ComponentName launcher(String packageName) {
		Intent intent = packages.getLaunchIntentForPackage(packageName);
		return intent == null ? null : intent.getComponent();
	}

	private ApplicationInfo info(String packageName) {
		try {
			return packages.getApplicationInfo(packageName, 0);
		} catch (PackageManager.NameNotFoundException | RuntimeException e) {
			return null;
		}
	}

	private static boolean usesReactNative(ApplicationInfo info) {
		// Libraries are only unpacked for apps that ask for it. Otherwise they stay in an APK, often a split one.
		if (info.nativeLibraryDir != null) {
			for (String library : LIBRARIES) {
				if (new File(info.nativeLibraryDir, library).exists()) {
					return true;
				}
			}
		}
		List<String> apks = new ArrayList<>();
		apks.add(info.sourceDir);
		if (info.splitSourceDirs != null) {
			apks.addAll(List.of(info.splitSourceDirs));
		}
		for (String apk : apks) {
			if (containsReactNative(new File(apk))) {
				return true;
			}
		}
		return false;
	}

	/** Whether an APK carries React Native's native library, for any ABI. */
	static boolean containsReactNative(File apk) {
		try (ZipFile zip = new ZipFile(apk)) {
			Enumeration<? extends ZipEntry> entries = zip.entries();
			while (entries.hasMoreElements()) {
				String name = entries.nextElement().getName();
				if (!name.startsWith("lib/")) {
					continue;
				}
				for (String library : LIBRARIES) {
					if (name.endsWith("/" + library)) {
						return true;
					}
				}
			}
			return false;
		} catch (IOException | SecurityException e) {
			return false;
		}
	}
}
