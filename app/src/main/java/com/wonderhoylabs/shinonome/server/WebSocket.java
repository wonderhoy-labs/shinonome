package com.wonderhoylabs.shinonome.server;

import android.util.Base64;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** The server side of RFC 6455, limited to the binary messages this protocol uses. */
final class WebSocket {

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int FIN = 0x80;
    private static final int OP_BINARY = 2;
    private static final int OP_CLOSE = 8;
    private static final int OP_PING = 9;
    private static final int OP_PONG = 10;
    private static final int MASKED = 0x80;
    // Client messages are small input events, so anything bigger is not our client.
    private static final int MAX_CLIENT_MESSAGE = 4096;

    private final Socket socket;
    private final DataInputStream in;
    private final OutputStream out;

    private WebSocket(Socket socket, InputStream in, OutputStream out) {
        this.socket = socket;
        this.in = new DataInputStream(in);
        this.out = out;
    }

    static WebSocket upgrade(Socket socket, InputStream in, OutputStream out, String key) throws IOException {
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII));
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + Base64.encodeToString(digest, Base64.NO_WRAP) + "\r\n\r\n";
        out.write(response.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        return new WebSocket(socket, in, out);
    }

    /** Sends one binary message made of a header and an optional body. */
    synchronized void send(byte[] head, byte[] body) throws IOException {
        int length = head.length + (body == null ? 0 : body.length);
        writeFrameHeader(OP_BINARY, length);
        out.write(head);
        if (body != null) {
            out.write(body);
        }
        out.flush();
    }

    /** Returns the next data message, answering control frames along the way. */
    byte[] read() throws IOException {
        while (true) {
            int first = in.readUnsignedByte();
            int second = in.readUnsignedByte();
            int opcode = first & 0x0F;
            if ((first & FIN) == 0 || (second & MASKED) == 0) {
                throw new IOException("Unsupported WebSocket frame");
            }
            int length = second & 0x7F;
            if (length == 126) {
                length = in.readUnsignedShort();
            } else if (length == 127) {
                throw new IOException("WebSocket message too large");
            }
            if (length > MAX_CLIENT_MESSAGE) {
                throw new IOException("WebSocket message too large");
            }
            byte[] mask = new byte[4];
            in.readFully(mask);
            byte[] payload = new byte[length];
            in.readFully(payload);
            for (int i = 0; i < length; i++) {
                payload[i] ^= mask[i & 3];
            }
            switch (opcode) {
                case OP_BINARY:
                    return payload;
                case OP_PING:
                    synchronized (this) {
                        writeFrameHeader(OP_PONG, length);
                        out.write(payload);
                        out.flush();
                    }
                    break;
                case OP_PONG:
                    break;
                case OP_CLOSE:
                    throw new EOFException("WebSocket closed by client");
                default:
                    throw new IOException("Unsupported WebSocket opcode " + opcode);
            }
        }
    }

    void setReadTimeout(int millis) throws IOException {
        socket.setSoTimeout(millis);
    }

    void setSendBufferSize(int bytes) throws IOException {
        socket.setSendBufferSize(bytes);
    }

    /** Closes on another thread, because closing TLS can block while a write is stuck on a dead link. */
    void close() {
        closeAfter(0);
    }

    /** Leaves time for a last message to reach the client first. */
    void closeAfter(long delayMs) {
        Thread closer = new Thread(() -> {
            try {
                Thread.sleep(delayMs);
                socket.close();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IOException e) {
                Log.error("close failed", e);
            }
        }, "close");
        closer.setDaemon(true);
        closer.start();
    }

    private void writeFrameHeader(int opcode, int length) throws IOException {
        out.write(FIN | opcode);
        if (length < 126) {
            out.write(length);
        } else if (length < 65536) {
            out.write(126);
            out.write(length >> 8);
            out.write(length);
        } else {
            out.write(127);
            for (int shift = 56; shift >= 0; shift -= 8) {
                out.write(shift >= 32 ? 0 : length >>> shift);
            }
        }
    }
}
