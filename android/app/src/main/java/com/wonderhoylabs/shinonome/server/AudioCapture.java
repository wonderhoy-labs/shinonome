package com.wonderhoylabs.shinonome.server;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.IOException;

/**
 * Records everything the phone plays, as 16-bit little-endian stereo PCM at 48 kHz, in 10 ms packets. Recording
 * the remote submix also stops the phone playing it, so the sound moves to the browser rather than coming out of
 * both. Raw PCM is 1.5 Mbit/s, small beside the video, and needs no encoder or decoder in the way.
 *
 * Adapted from scrcpy's AudioDirectCapture (Apache-2.0).
 */
final class AudioCapture {

	static final int SAMPLE_RATE = 48_000;
	private static final int CHANNEL_MASK = AudioFormat.CHANNEL_IN_STEREO;
	private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;
	private static final int PACKET_BYTES = SAMPLE_RATE / 100 * 2 * 2;
	private static final long PACKET_US = 10_000;

	interface Sink {
		/** On the capture thread. captureUs is when the packet's first sample was recorded, on System.nanoTime. */
		void onAudio(long captureUs, byte[] pcm);

		void onAudioFailed(String reason);
	}

	private final AudioRecord record;
	private final Thread thread;
	private volatile boolean running = true;

	// The shell user holds RECORD_AUDIO and CAPTURE_AUDIO_OUTPUT, which let it record the remote submix. Lint can't see
	// that from the app's manifest, and only lists the sources an app may use.
	@SuppressLint({"MissingPermission", "WrongConstant"})
	AudioCapture(Context context, Sink sink) throws IOException {
		AudioFormat format = new AudioFormat.Builder()
				.setEncoding(ENCODING)
				.setSampleRate(SAMPLE_RATE)
				.setChannelMask(CHANNEL_MASK)
				.build();
		AudioRecord.Builder builder = new AudioRecord.Builder()
				.setContext(context)
				.setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
				.setAudioFormat(format);
		int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_MASK, ENCODING);
		if (minimum > 0) {
			// Room to ride out a stalled link. Reads return as soon as a packet is there, so it adds no delay.
			builder.setBufferSizeInBytes(8 * minimum);
		}
		try {
			record = builder.build();
		} catch (UnsupportedOperationException | SecurityException e) {
			throw new IOException("audio capture refused: " + e.getMessage(), e);
		}
		if (record.getState() != AudioRecord.STATE_INITIALIZED) {
			record.release();
			throw new IOException("audio capture did not initialize");
		}
		try {
			record.startRecording();
		} catch (IllegalStateException e) {
			record.release();
			throw new IOException("audio capture did not start: " + e.getMessage(), e);
		}
		thread = new Thread(() -> readLoop(sink), "audio");
		thread.setDaemon(true);
		thread.start();
	}

	private void readLoop(Sink sink) {
		byte[] packet = new byte[PACKET_BYTES];
		try {
			while (running) {
				int read = 0;
				while (read < PACKET_BYTES && running) {
					int got = record.read(packet, read, PACKET_BYTES - read);
					if (got < 0) {
						if (running) {
							sink.onAudioFailed("audio read failed: " + got);
						}
						return;
					}
					read += got;
				}
				if (!running) {
					return;
				}
				// Nothing playing is all zeros. Not sending it saves the link 1.5 Mbit/s of nothing.
				if (isSilent(packet)) {
					continue;
				}
				sink.onAudio(System.nanoTime() / 1000 - PACKET_US, packet.clone());
			}
		} finally {
			record.release();
		}
	}

	private static boolean isSilent(byte[] packet) {
		for (byte b : packet) {
			if (b != 0) {
				return false;
			}
		}
		return true;
	}

	/** Ends recording, which hands the sound back to the phone's speaker. */
	void stop() {
		running = false;
		try {
			record.stop();
		} catch (IllegalStateException e) {
			// Already released by the capture thread.
		}
	}
}
