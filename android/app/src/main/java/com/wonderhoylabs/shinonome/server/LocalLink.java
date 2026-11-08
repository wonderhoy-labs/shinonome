package com.wonderhoylabs.shinonome.server;

import android.net.LocalSocket;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/**
 * Messages over a local socket, which is how a browser on USB reaches the server through adb. Each
 * one is a big-endian 32-bit length and then the message. adb has already authorized the computer
 * and the link has no network in it, so this needs neither TLS nor a pairing code.
 */
final class LocalLink implements Link {

	// Client messages are small input events, so anything bigger is not our client.
	private static final int MAX_CLIENT_MESSAGE = 4096;
	private static final int OUTPUT_BUFFER_BYTES = 64 * 1024;

	private final LocalSocket socket;
	private final DataInputStream in;
	private final DataOutputStream out;

	LocalLink(LocalSocket socket) throws IOException {
		this.socket = socket;
		this.in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
		this.out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), OUTPUT_BUFFER_BYTES));
	}

	@Override
	public synchronized void send(byte[] head, byte[] body) throws IOException {
		out.writeInt(head.length + (body == null ? 0 : body.length));
		out.write(head);
		if (body != null) {
			out.write(body);
		}
		out.flush();
	}

	@Override
	public byte[] read() throws IOException {
		int length = in.readInt();
		if (length < 1 || length > MAX_CLIENT_MESSAGE) {
			throw new IOException("Bad message length " + length);
		}
		byte[] message = new byte[length];
		in.readFully(message);
		return message;
	}

	@Override
	public void setReadTimeout(int millis) throws IOException {
		socket.setSoTimeout(millis);
	}

	@Override
	public void setSendBufferSize(int bytes) throws IOException {
		socket.setSendBufferSize(bytes);
	}

	@Override
	public void close() {
		closeAfter(0);
	}

	@Override
	public void closeAfter(long delayMs) {
		Thread closer = new Thread(() -> {
			try {
				Thread.sleep(delayMs);
				// Closing alone would leave another thread blocked in read() forever.
				socket.shutdownInput();
				socket.shutdownOutput();
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			} catch (IOException e) {
				Log.info("local client already gone: " + e.getMessage());
			}
			try {
				socket.close();
			} catch (IOException e) {
				Log.error("close failed", e);
			}
		}, "close");
		closer.setDaemon(true);
		closer.start();
	}
}
