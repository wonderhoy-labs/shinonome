package com.wonderhoylabs.shinonome.server;

import android.graphics.PixelFormat;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;

/**
 * Where the display draws while no web client is encoding it. A display without a surface counts as
 * off, which would freeze its apps and leave native clients nothing to mirror. A tiny surface keeps
 * the display on while costing almost nothing to fill.
 */
final class IdleSurface {

    private static final int WIDTH = 16;
    private static final int HEIGHT = 9;
    private static final int MAX_IMAGES = 2;

    private final ImageReader reader;

    IdleSurface() {
        HandlerThread thread = new HandlerThread("idle-surface");
        thread.setDaemon(true);
        thread.start();
        reader = ImageReader.newInstance(WIDTH, HEIGHT, PixelFormat.RGBA_8888, MAX_IMAGES);
        reader.setOnImageAvailableListener(source -> {
            Image image = source.acquireLatestImage();
            if (image != null) {
                image.close();
            }
        }, new Handler(thread.getLooper()));
    }

    Surface surface() {
        return reader.getSurface();
    }
}
