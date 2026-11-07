package com.wonderhoylabs.shinonome.server;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Bundle;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;

/** Hardware H.264 encoder fed by the virtual display through a Surface. */
final class Encoder {

    static final int FLAG_CONFIG = 1;
    static final int FLAG_KEY = 2;

    interface Sink {
        void onFrame(int flags, long captureUs, long encodedUs, byte[] data);
    }

    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final int I_FRAME_INTERVAL_SECONDS = 10;
    private static final long REPEAT_AFTER_US = 100_000;
    private static final long DEQUEUE_TIMEOUT_US = 100_000;

    private final MediaCodec codec;
    private final String name;
    private final Surface surface;
    private final Thread thread;
    private volatile boolean running = true;

    Encoder(Options options, Sink sink) throws IOException {
        MediaFormat format = MediaFormat.createVideoFormat(MIME, options.width, options.height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, options.bitrate);
        // Required to configure the encoder. The real rate follows whatever the display produces.
        format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_SECONDS);
        format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_AFTER_US);
        format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        format.setInteger(MediaFormat.KEY_LATENCY, 1);
        format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        for (String setting : options.encoderSettings) {
            String[] parts = setting.split("=", 2);
            format.setInteger(parts[0], Integer.parseInt(parts[1]));
        }

        codec = options.encoderName != null
                ? MediaCodec.createByCodecName(options.encoderName)
                : MediaCodec.createEncoderByType(MIME);
        // Kept, because the codec can't say once it's released, and a resize can release it at any moment.
        name = codec.getName();
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        surface = codec.createInputSurface();
        codec.start();
        Log.info("encoder " + name + " " + options.width + "x" + options.height
                + " at " + options.bitrate + " bit/s " + options.encoderSettings);

        thread = new Thread(() -> drain(sink), "encoder");
        thread.start();
    }

    Surface surface() {
        return surface;
    }

    String name() {
        return name;
    }

    void requestKeyFrame() {
        Bundle params = new Bundle();
        params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        codec.setParameters(params);
    }

    void stop() {
        running = false;
        try {
            thread.join(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        codec.stop();
        codec.release();
        surface.release();
    }

    private void drain(Sink sink) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running) {
            int index;
            try {
                index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US);
            } catch (IllegalStateException e) {
                Log.error("encoder stopped", e);
                return;
            }
            if (index < 0) {
                continue;
            }
            long encodedUs = System.nanoTime() / 1000;
            ByteBuffer buffer = codec.getOutputBuffer(index);
            byte[] data = new byte[info.size];
            buffer.position(info.offset);
            buffer.limit(info.offset + info.size);
            buffer.get(data);
            int flags = 0;
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                flags |= FLAG_CONFIG;
            }
            if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
                flags |= FLAG_KEY;
            }
            long captureUs = info.presentationTimeUs;
            codec.releaseOutputBuffer(index, false);
            if (data.length > 0) {
                sink.onFrame(flags, captureUs, encodedUs, data);
            }
        }
    }
}
