package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.PowerManager;

/**
 * Holds the phone's CPU and Wi-Fi awake once a client has connected. With the screen off, the phone
 * would otherwise suspend and drop into Wi-Fi power saving, which stalls the video.
 *
 * Android releases both when the process exits, so they cannot outlive the server.
 */
final class KeepAlive {

    private static final String TAG = "shinonome:session";

    private final Context context;
    private boolean held;

    KeepAlive(Context context) {
        this.context = context;
    }

    void acquire() {
        if (held) {
            return;
        }
        held = true;
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG);
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            Log.info("wake lock held");
        } catch (RuntimeException e) {
            Log.error("no wake lock", e);
        }
        try {
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            WifiManager.WifiLock wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, TAG);
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
            Log.info("wifi lock held");
        } catch (RuntimeException e) {
            Log.error("no wifi lock", e);
        }
    }
}
