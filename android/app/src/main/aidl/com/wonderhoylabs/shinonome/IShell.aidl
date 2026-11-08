package com.wonderhoylabs.shinonome;

import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;

interface IShell {
    /** Runs a script as the shell user and returns what it printed. */
    String run(String script) = 1;

    /** Shows the desktop on this surface, creating it if needed. Returns the display ID. */
    int attachDesktop(in Surface surface, int width, int height, int dpi) = 2;

    /** Keeps the desktop running without a surface until the app comes back. */
    void detachDesktop() = 3;

    /** Ends the desktop, which moves its windows back to the phone. */
    void endDesktop() = 4;

    /** Moves an ordinary app that took over the phone's screen into the desktop. Returns whether it did. */
    boolean adoptForegroundApp(String desktopActivity) = 7;

    /** Whether Android treats the current display as a desktop. Some builds create it and do not. */
    boolean isDesktopEligible() = 8;

    oneway void injectMotion(in MotionEvent event, int actionButton) = 5;

    oneway void injectKey(in KeyEvent event) = 6;

    /** Shizuku calls this transaction to end the service. */
    void destroy() = 16777114;
}
