package com.wonderhoylabs.shinonome.server;

import java.io.IOException;

/** Carries whole messages between the server and one client. See web/client.js for the messages. */
interface Link {

    /** Sends one message made of a header and an optional body. */
    void send(byte[] head, byte[] body) throws IOException;

    /** Returns the next message from the client. */
    byte[] read() throws IOException;

    void setReadTimeout(int millis) throws IOException;

    void setSendBufferSize(int bytes) throws IOException;

    /** Closes without blocking, because a write can be stuck on a dead connection. */
    void close();

    /** Leaves time for a last message to reach the client first. */
    void closeAfter(long delayMs);
}
