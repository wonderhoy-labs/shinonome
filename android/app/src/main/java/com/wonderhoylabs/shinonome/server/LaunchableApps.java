package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.util.List;

/**
 * Lists the apps on the phone's launcher, with their names and icons, so a page can offer one to show alone with
 * {@code --app}. Each is one line: {@code app}, the activity, the name and the icon as base64 WebP, split by tabs.
 */
final class LaunchableApps {
	/** Small, since a phone has a hundred or more of them and they all cross adb at once. */
	private static final int ICON_QUALITY = 85;

	private LaunchableApps() {
	}

	static void print(Context context, int iconSize) {
		PackageManager manager = context.getPackageManager();
		Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
		List<ResolveInfo> found = manager.queryIntentActivities(launcher, 0);
		for (ResolveInfo info : found) {
			ActivityInfo activity = info.activityInfo;
			String component = activity.packageName + "/" + activity.name;
			String name = oneLine(info.loadLabel(manager).toString());
			String icon = "";
			try {
				icon = iconData(info.loadIcon(manager), iconSize);
			} catch (RuntimeException e) {
				// An app whose icon won't draw is still worth listing.
			}
			System.out.println("app\t" + component + "\t" + (name.isEmpty() ? activity.packageName : name) + "\t" + icon);
		}
	}

	/** Names can hold any character, and tabs and line breaks would break the line apart. */
	private static String oneLine(String text) {
		return text.replaceAll("\\s+", " ").trim();
	}

	private static String iconData(Drawable drawable, int size) {
		Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
		Canvas canvas = new Canvas(bitmap);
		drawable.setBounds(0, 0, size, size);
		drawable.draw(canvas);
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		bitmap.compress(Bitmap.CompressFormat.WEBP_LOSSY, ICON_QUALITY, out);
		bitmap.recycle();
		return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
	}
}
