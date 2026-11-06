package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.os.Looper;

/** Entry point. Runs as the shell user through app_process, started by assets/start.sh. */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        Options options = Options.parse(args);
        if (options.listEncoders) {
            listEncoders();
            return;
        }
        Looper.prepareMainLooper();
        Context context;
        try {
            context = Hidden.createShellContext();
        } catch (ReflectiveOperationException e) {
            Log.info("incompatible: Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT
                    + ") has changed internals this server relies on: " + e);
            return;
        }
        new Server(context, options).run();
        System.exit(0);
    }

    private static void listEncoders() {
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos()) {
            if (!info.isEncoder()) {
                continue;
            }
            for (String type : info.getSupportedTypes()) {
                if (type.startsWith("video/")) {
                    Log.info(info.getName() + " " + type + (info.isHardwareAccelerated() ? " hardware" : " software"));
                }
            }
        }
    }
}
