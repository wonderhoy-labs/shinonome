package com.wonderhoylabs.shinonome.server;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.hardware.display.VirtualDisplayConfig;
import android.os.Build;
import android.view.Surface;

import java.io.IOException;
import java.lang.reflect.Constructor;

/**
 * Creates the virtual display that Android treats as a desktop. See README.md for why these flags.
 * DESTROY_CONTENT_ON_REMOVAL is left off on purpose: without it, windows go back to the phone when
 * the display goes away.
 */
final class DesktopDisplay {

    private static final int FLAG_PUBLIC = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC;
    private static final int FLAG_SUPPORTS_TOUCH = 1 << 6;
    private static final int FLAG_TRUSTED = 1 << 10;
    private static final int FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13;
    private static final int FLAG_ALLOWS_CONTENT_MODE_SWITCH = 1 << 17;
    private static final int FLAGS = FLAG_PUBLIC | FLAG_TRUSTED | FLAG_ALLOWS_CONTENT_MODE_SWITCH
            | FLAG_SUPPORTS_TOUCH | FLAG_TOUCH_FEEDBACK_DISABLED;

    /** Lets the desktop keep running while the phone is locked. */
    static final int FLAGS_KEEP_RUNNING_LOCKED = 1 << 11 | 1 << 12; // OWN_DISPLAY_GROUP | ALWAYS_UNLOCKED

    // Android restores a desktop's windows when a display with the same ID comes back. Two live
    // displays must never share an ID, or removing one makes Android's display layout code throw.
    static final String ID_REMOTE_SESSION = "shinonome";
    static final String ID_APP = "shinonome-app";

    private DesktopDisplay() {
    }

    /** Explains why this device cannot work, or returns null if it might. */
    static String incompatibility(Context context) {
        try {
            DisplayManager.class.getField("VIRTUAL_DISPLAY_FLAG_ALLOWS_CONTENT_MODE_SWITCH");
        } catch (NoSuchFieldException e) {
            return "Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT
                    + ") cannot give a virtual display a desktop. This needs a build with the"
                    + " ALLOWS_CONTENT_MODE_SWITCH display flag, such as Android 17.";
        }
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FREEFORM_WINDOW_MANAGEMENT)) {
            return "This device does not support desktop windows. Try turning on Enable desktop experience"
                    + " features in Developer options, then reboot.";
        }
        return null;
    }

    static DisplayManager manager(Context context) throws ReflectiveOperationException {
        Constructor<DisplayManager> ctor = DisplayManager.class.getDeclaredConstructor(Context.class);
        ctor.setAccessible(true);
        return ctor.newInstance(context);
    }

    // The flags include ones the public SDK does not list, which lint reports as a wrong constant.
    @SuppressLint("WrongConstant")
    static VirtualDisplay create(DisplayManager manager, String uniqueId, int width, int height, int dpi,
            int extraFlags, Surface surface) throws IOException, ReflectiveOperationException {
        VirtualDisplayConfig.Builder config = new VirtualDisplayConfig.Builder(uniqueId, width, height, dpi)
                .setFlags(FLAGS | extraFlags)
                .setSurface(surface);
        VirtualDisplayConfig.Builder.class.getMethod("setUniqueId", String.class).invoke(config, uniqueId);
        VirtualDisplay display = manager.createVirtualDisplay(config.build());
        if (display == null) {
            throw new IOException("createVirtualDisplay returned null");
        }
        return display;
    }
}
