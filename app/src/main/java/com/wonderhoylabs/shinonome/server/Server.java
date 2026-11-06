package com.wonderhoylabs.shinonome.server;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.view.Display;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLServerSocketFactory;

/**
 * Serves the web client over HTTPS and runs one desktop session over a WebSocket.
 *
 * Message format: one type byte, then big-endian fields. See web/client.js for the other side.
 */
final class Server {

    private static final int TYPE_VIDEO = 1;
    private static final int TYPE_STATUS = 2;
    private static final int TYPE_PONG = 3;
    private static final int TYPE_AUTH_CHALLENGE = 4;
    private static final int TYPE_AUTH_RESULT = 5;
    private static final int TYPE_REPLACED = 6;
    private static final int TYPE_MOUSE = 16;
    private static final int TYPE_SCROLL = 17;
    private static final int TYPE_KEY = 18;
    private static final int TYPE_PING = 19;
    private static final int TYPE_STOP = 20;
    private static final int TYPE_AUTH_RESPONSE = 21;
    private static final int TYPE_KEY_FRAME = 22;

    private static final int AUTH_OK = 1;
    private static final int AUTH_WRONG_CODE = 0;
    private static final int AUTH_LOCKED_OUT = 2;

    private static final int SETUP_TIMEOUT_MS = 15_000;
    private static final int CLIENT_SILENCE_LIMIT_MS = 8_000;
    private static final int TICK_MS = 500;
    private static final int POWER_CHECK_MS = 100;
    private static final int PANEL_SETTLE_MS = 250;
    private static final int KEEP_AWAKE_TICKS = 4;
    private static final int NATIVE_CHECK_TICKS = 4;
    private static final long FAREWELL_MS = 500;
    private static final int ELIGIBILITY_CHECK_TICK = 10;
    private static final String NATIVE_SERVER_CLASS = "com.genymobile.scrcpy.Server";
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_FAILURES_BEFORE_LOCKOUT = 5;
    private static final long LOCKOUT_MS = 30_000;
    // Small, so a slow link makes us drop frames rather than buffer seconds of old video.
    private static final int SEND_BUFFER_BYTES = 192 * 1024;
    private static final int QUEUED_FRAMES = 6;
    private static final int SENDER_POLL_MS = 100;

    private static final Pattern LOCAL_NETWORK_NAMES = Pattern.compile("(wlan|swlan|ap|eth|rndis|ncm|usb).*");

    private static final List<String> WEB_FILES =
            Collections.unmodifiableList(Arrays.asList("index.html", "client.js", "style.css", "logo.webp"));

    private final Context context;
    private final Options options;
    private final File dir;
    private final SecureRandom random = new SecureRandom();
    private final Object lock = new Object();

    private Map<String, byte[]> webFiles;
    private String pairingCode;
    private ServerSocket serverSocket;

    // Guarded by lock.
    private VirtualDisplay display;
    private int displayId = Display.INVALID_DISPLAY;
    private Input input;
    private Session current;
    private long idleSince = System.currentTimeMillis();
    private boolean everConnected;
    private boolean screenOffApplied;
    private boolean panelDark;
    private Display phoneDisplay;
    private IdleSurface idleSurface;

    // Guarded by this.
    private int failedAttempts;
    private long lockedOutUntil;

    private volatile boolean stopping;
    private volatile boolean locked = true;
    private volatile boolean unlockedThisSession;
    private volatile boolean nativeClientAttached;
    private volatile boolean desktopEligible = true;
    private final KeepAlive keepAlive;

    Server(Context context, Options options) {
        this.context = context;
        this.options = options;
        this.dir = new File(options.dir);
        this.keepAlive = new KeepAlive(context);
    }

    /** Android creates the desktop only after an unlock, and input must not reach a phone locked before that. */
    private boolean isUsable() {
        return !locked || (options.keepRunningLocked && unlockedThisSession);
    }

    void run() throws IOException, GeneralSecurityException {
        String problem = DesktopDisplay.incompatibility(context);
        if (problem != null) {
            Log.info("incompatible: " + problem);
            return;
        }
        webFiles = loadWebFiles();
        pairingCode = Secrets.loadOrCreatePairingCode(dir);
        Tls tls = Tls.loadOrCreate(dir, localAddresses());
        SSLServerSocketFactory factory = tls.serverSocketFactory();
        serverSocket = factory.createServerSocket(options.port);

        for (String address : localAddressStrings()) {
            Log.info("url: https://" + address + ":" + options.port + "/");
        }
        Log.info("pairing code: " + pairingCode);
        Log.info("certificate sha-256: " + tls.fingerprint());
        createDisplay();
        Log.info("native: " + nativeCommand(nativeWifiConnection()));
        Log.info("native usb: " + nativeCommand("-d"));
        Log.info("listening");

        Thread watchdog = new Thread(this::watch, "watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        Thread keeper = new Thread(this::keepPhoneAwake, "keep-awake");
        keeper.setDaemon(true);
        keeper.start();

        while (!stopping) {
            Socket socket;
            try {
                socket = serverSocket.accept();
            } catch (SocketException e) {
                break;
            }
            new Thread(() -> handle(socket), "client").start();
        }
    }

    private void handle(Socket socket) {
        boolean handedOver = false;
        try {
            socket.setSoTimeout(SETUP_TIMEOUT_MS);
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);
            Map<String, String> headers = new HashMap<>();
            String path = readRequest(in, headers);
            if (path == null) {
                return;
            }
            if ("/ws".equals(path) && "websocket".equalsIgnoreCase(headers.get("upgrade"))) {
                if (!isSameOrigin(headers)) {
                    respond(out, "403 Forbidden", "text/plain", new byte[0]);
                    return;
                }
                WebSocket ws = WebSocket.upgrade(socket, in, out, headers.get("sec-websocket-key"));
                if (authenticate(ws)) {
                    handedOver = true;
                    runSession(ws);
                } else {
                    ws.close();
                    handedOver = true;
                }
            } else {
                serveFile(path, out);
            }
        } catch (EOFException | javax.net.ssl.SSLException e) {
            // A browser refusing the certificate, or a client going away, is normal.
            Log.info("client went away: " + e.getMessage());
        } catch (IOException e) {
            Log.info("client failed: " + e);
        } finally {
            if (!handedOver) {
                closeQuietly(socket);
            }
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException e) {
            Log.info("close failed: " + e);
        }
    }

    private static String readRequest(InputStream in, Map<String, String> headers) throws IOException {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int value = in.read();
            if (value < 0) {
                return null;
            }
            raw.write(value);
            if (raw.size() > MAX_HEADER_BYTES) {
                return null;
            }
            boolean expected = value == ((matched % 2 == 0) ? '\r' : '\n');
            matched = expected ? matched + 1 : (value == '\r' ? 1 : 0);
        }
        String[] lines = new String(raw.toByteArray(), StandardCharsets.US_ASCII).split("\r\n");
        String[] request = lines[0].split(" ");
        if (request.length < 2 || !"GET".equals(request[0])) {
            return null;
        }
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) {
                headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT),
                        lines[i].substring(colon + 1).trim());
            }
        }
        int query = request[1].indexOf('?');
        return query < 0 ? request[1] : request[1].substring(0, query);
    }

    private static boolean isSameOrigin(Map<String, String> headers) {
        String origin = headers.get("origin");
        String host = headers.get("host");
        return origin != null && host != null && origin.equals("https://" + host);
    }

    /** The web client ships inside the APK that this process was started from. */
    private static Map<String, byte[]> loadWebFiles() throws IOException {
        Map<String, byte[]> files = new HashMap<>();
        try (ZipFile apk = new ZipFile(System.getProperty("java.class.path"))) {
            for (String name : WEB_FILES) {
                ZipEntry entry = apk.getEntry("assets/web/" + name);
                if (entry == null) {
                    throw new IOException("Missing from the APK: " + name);
                }
                try (InputStream in = apk.getInputStream(entry)) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[16 * 1024];
                    for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) {
                        bytes.write(buffer, 0, read);
                    }
                    files.put(name, bytes.toByteArray());
                }
            }
        }
        return files;
    }

    private void serveFile(String path, OutputStream out) throws IOException {
        String name = "/".equals(path) ? "index.html" : path.substring(1);
        byte[] body = webFiles.get(name);
        if (body == null) {
            respond(out, "404 Not Found", "text/plain", "Not found".getBytes(StandardCharsets.US_ASCII));
            return;
        }
        String type = name.endsWith(".html") ? "text/html; charset=utf-8"
                : name.endsWith(".js") ? "text/javascript; charset=utf-8"
                : name.endsWith(".webp") ? "image/webp" : "text/css; charset=utf-8";
        respond(out, "200 OK", type, body);
    }

    private static void respond(OutputStream out, String status, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Content-Security-Policy: default-src 'self'; connect-src 'self'\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    /** Challenge and response, so the pairing code itself is never sent over the connection. */
    private boolean authenticate(WebSocket ws) throws IOException {
        byte[] nonce = new byte[32];
        random.nextBytes(nonce);
        ws.send(message(TYPE_AUTH_CHALLENGE, nonce), null);

        byte[] response = ws.read();
        synchronized (this) {
            if (System.currentTimeMillis() < lockedOutUntil) {
                ws.send(message(TYPE_AUTH_RESULT, new byte[] {AUTH_LOCKED_OUT}), null);
                return false;
            }
        }
        boolean valid = response.length == 33 && (response[0] & 0xFF) == TYPE_AUTH_RESPONSE
                && MessageDigest.isEqual(expectedResponse(nonce), Arrays.copyOfRange(response, 1, 33));
        synchronized (this) {
            if (valid) {
                failedAttempts = 0;
            } else if (++failedAttempts >= MAX_FAILURES_BEFORE_LOCKOUT) {
                lockedOutUntil = System.currentTimeMillis() + LOCKOUT_MS;
                failedAttempts = 0;
                Log.info("too many wrong pairing codes, locked out for " + LOCKOUT_MS / 1000 + "s");
            }
        }
        ws.send(message(TYPE_AUTH_RESULT, new byte[] {(byte) (valid ? AUTH_OK : AUTH_WRONG_CODE)}), null);
        return valid;
    }

    private byte[] expectedResponse(byte[] nonce) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pairingCode.getBytes(StandardCharsets.US_ASCII), "HmacSHA256"));
            return mac.doFinal(nonce);
        } catch (GeneralSecurityException e) {
            throw new IOException(e);
        }
    }

    private static byte[] message(int type, byte[] payload) {
        byte[] out = new byte[payload.length + 1];
        out[0] = (byte) type;
        System.arraycopy(payload, 0, out, 1, payload.length);
        return out;
    }

    private void runSession(WebSocket ws) throws IOException {
        ws.setReadTimeout(0);
        ws.setSendBufferSize(SEND_BUFFER_BYTES);
        Session session = new Session(ws);
        synchronized (lock) {
            if (stopping) {
                ws.close();
                return;
            }
            if (current != null) {
                Log.info("new client replaces the old one");
                current.closeAsReplaced();
            }
            try {
                session.start();
            } catch (IOException e) {
                session.close();
                throw e;
            }
            current = session;
            everConnected = true;
            keepAlive.acquire();
        }
        Log.info("client connected");
        try {
            session.readLoop();
        } catch (IOException e) {
            Log.info("client disconnected: " + e.getMessage());
        } finally {
            synchronized (lock) {
                session.close();
                if (current == session) {
                    current = null;
                    idleSince = System.currentTimeMillis();
                }
            }
        }
    }

    /** Native clients attach to a display that already exists, so it is created up front. */
    private void createDisplay() throws IOException {
        try {
            idleSurface = new IdleSurface();
            DisplayManager manager = DesktopDisplay.manager(context);
            phoneDisplay = manager.getDisplay(Display.DEFAULT_DISPLAY);
            display = DesktopDisplay.create(manager, DesktopDisplay.ID_REMOTE_SESSION,
                    options.width, options.height, options.dpi,
                    options.keepRunningLocked ? DesktopDisplay.FLAGS_KEEP_RUNNING_LOCKED : 0,
                    idleSurface.surface());
            displayId = display.getDisplay().getDisplayId();
            input = new Input(context, displayId);
            Hidden.setImePolicy(displayId, Hidden.DISPLAY_IME_POLICY_HIDE);
            Log.info("display " + displayId + " created");
        } catch (ReflectiveOperationException e) {
            throw new IOException(e);
        }
    }

    /**
     * Uses scrcpy's UHID mouse because its default mouse sends events to scrcpy's own private mirror
     * display, and dragging a title bar with those crashes SystemUI, which closes the desktop's
     * windows. See README.md. A connection is named because scrcpy stops with an error when it sees both.
     */
    private String nativeCommand(String connection) {
        return "scrcpy " + connection + " --display-id=" + displayId
                + " --mouse=uhid --no-power-on --video-bit-rate=" + options.bitrate / 1_000_000 + "M";
    }

    private String nativeWifiConnection() throws SocketException {
        List<String> addresses = localAddressStrings();
        return options.adbPort > 0 && !addresses.isEmpty()
                ? "--tcpip=" + addresses.get(0) + ":" + options.adbPort
                : "-e";
    }

    /** scrcpy starts its own server process, so it can only be noticed from the outside. */
    private static boolean isNativeClientRunning() {
        try {
            return new ProcessBuilder("pgrep", "-f", NATIVE_SERVER_CLASS)
                    .redirectErrorStream(true).start().waitFor() == 0;
        } catch (IOException e) {
            Log.error("could not look for native clients", e);
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private boolean hasClient() {
        return current != null || nativeClientAttached;
    }

    /**
     * Android puts every virtual display in the phone's display group, so when the phone sleeps the
     * desktop is blanked and its apps stop. Real external displays get their own group, but a virtual
     * one cannot. So during a session the phone never stays asleep: when it sleeps, which also locks
     * it, wake it straight back up behind a forced-dark screen. The desktop never notices.
     *
     * The power button still works as people expect. Pressing it while the phone is unlocked locks it.
     * Pressing it while locked and dark shows the lock screen, so the phone can still be used.
     */
    private void keepPhoneAwake() {
        boolean lockedBeforeSleep = true;
        long darkNotBefore = 0;
        while (!stopping) {
            try {
                Thread.sleep(POWER_CHECK_MS);
            } catch (InterruptedException e) {
                return;
            }
            synchronized (lock) {
                // Checked again here: stop() holds the lock while it puts the phone to sleep.
                if (stopping) {
                    return;
                }
                if (!hasClient() && !panelDark) {
                    continue;
                }
                long now = System.currentTimeMillis();
                if (Hidden.isInteractive()) {
                    lockedBeforeSleep = Hidden.isKeyguardLocked();
                } else if (options.keepRunningLocked && unlockedThisSession) {
                    panelDark = options.screenOff && !(panelDark && lockedBeforeSleep);
                    Hidden.wakeUp();
                    // Android applies its own screen change a moment later on another thread. Forcing
                    // the screen off inside that gap lets the late change win, so wait it out.
                    darkNotBefore = now + PANEL_SETTLE_MS;
                    Log.info("phone slept, woke it with the screen " + (panelDark ? "dark" : "on"));
                }
                if (panelDark && now >= darkNotBefore && phoneDisplay.getState() == Display.STATE_ON
                        && !Hidden.requestDisplayPower(Display.DEFAULT_DISPLAY, false)) {
                    // Without this it would try again, and log the failure, ten times a second.
                    Log.info("this phone cannot turn its screen off during a session, so it stays on");
                    panelDark = false;
                }
            }
        }
    }

    private void watch() {
        int tick = 0;
        while (!stopping) {
            try {
                Thread.sleep(TICK_MS);
            } catch (InterruptedException e) {
                return;
            }
            tick++;
            if (new File(dir, "stop").exists()) {
                stop("stop file");
                return;
            }
            boolean nowLocked = Hidden.isKeyguardLocked();
            boolean changed = nowLocked != locked;
            locked = nowLocked;
            if (!nowLocked) {
                unlockedThisSession = true;
            }
            if (tick % NATIVE_CHECK_TICKS == 0) {
                nativeClientAttached = isNativeClientRunning();
            }
            if (tick == ELIGIBILITY_CHECK_TICK) {
                desktopEligible = Hidden.isEligibleForDesktopMode(displayId);
                Log.info("desktop eligible: " + desktopEligible);
                if (!desktopEligible) {
                    Log.info("Android did not make this a desktop. Try turning on Enable desktop experience"
                            + " features in Developer options, then reboot.");
                }
                changed = true;
            }
            synchronized (lock) {
                if (current != null && System.currentTimeMillis() - current.lastMessageAt > CLIENT_SILENCE_LIMIT_MS) {
                    Log.info("client went silent");
                    current.close();
                    current = null;
                    idleSince = System.currentTimeMillis();
                }
                if (current != null && changed) {
                    current.statusDirty = true;
                }
                if (hasClient()) {
                    everConnected = true;
                    idleSince = System.currentTimeMillis();
                    if (!locked) {
                        applyScreenOff();
                    }
                } else {
                    long limit = (everConnected ? options.graceSeconds : options.idleSeconds) * 1000L;
                    if (System.currentTimeMillis() - idleSince > limit) {
                        stop("idle");
                        return;
                    }
                }
                // With the screen forced off, also keep the phone awake between connections, or
                // a Wi-Fi blip would lock it and need someone to unlock it to carry on.
                boolean keepAwake = (hasClient() || panelDark) && (!locked || options.keepRunningLocked);
                if (keepAwake && tick % KEEP_AWAKE_TICKS == 0) {
                    Hidden.userActivity(Display.DEFAULT_DISPLAY);
                }
            }
        }
    }

    /**
     * Called with lock held. Waits for a client, so the phone stays readable while setting up, and
     * applies only once, so the phone stays usable if someone unlocks it later in the session.
     */
    private void applyScreenOff() {
        if (!options.screenOff || screenOffApplied) {
            return;
        }
        screenOffApplied = true;
        panelDark = true;
        Log.info("phone screen off");
    }

    /** Ends everything. The phone would otherwise stay awake, and possibly unlocked, with a dark screen. */
    private void stop(String reason) {
        Log.info("stopping: " + reason);
        stopping = true;
        synchronized (lock) {
            if (current != null) {
                current.close();
                current = null;
            }
            if (display != null) {
                try {
                    display.release();
                } catch (RuntimeException e) {
                    // Must not stop the phone being locked below. Exiting releases the display anyway.
                    Log.error("could not release the display", e);
                }
                display = null;
            }
            // Leave the phone truly asleep and locked, unless someone is using it.
            if (panelDark || Hidden.isKeyguardLocked()) {
                lockPhone();
            }
        }
        if (!new File(dir, "stop").delete()) {
            Log.info("no stop file to remove");
        }
        Log.info("stopped");
        System.exit(0);
    }

    private static void lockPhone() {
        try {
            new ProcessBuilder("input", "keyevent", "SLEEP").start().waitFor();
        } catch (IOException | InterruptedException e) {
            Log.error("could not lock the phone", e);
        }
    }

    /**
     * Addresses a nearby computer could reach. This skips VPNs and cellular, and includes IPv6
     * because some networks, such as phone hotspots, give the phone no IPv4 address at all.
     */
    private static List<byte[]> localAddresses() throws SocketException {
        List<byte[]> addresses = new ArrayList<>();
        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp() || !LOCAL_NETWORK_NAMES.matcher(network.getName()).matches()) {
                continue;
            }
            for (InetAddress address : Collections.list(network.getInetAddresses())) {
                boolean usableIpv4 = address instanceof Inet4Address && address.isSiteLocalAddress();
                boolean usableIpv6 = address instanceof Inet6Address && !address.isLinkLocalAddress();
                if (usableIpv4 || usableIpv6) {
                    addresses.add(address.getAddress());
                }
            }
        }
        return addresses;
    }

    private static List<String> localAddressStrings() throws SocketException {
        List<String> names = new ArrayList<>();
        for (byte[] bytes : localAddresses()) {
            try {
                String host = InetAddress.getByAddress(bytes).getHostAddress();
                names.add(bytes.length == 4 ? host : "[" + host + "]");
            } catch (UnknownHostException e) {
                throw new SocketException(e.getMessage());
            }
        }
        return names;
    }

    private static final class Frame {
        final int flags;
        final long captureUs;
        final long encodedUs;
        final byte[] data;

        Frame(int flags, long captureUs, long encodedUs, byte[] data) {
            this.flags = flags;
            this.captureUs = captureUs;
            this.encodedUs = encodedUs;
            this.data = data;
        }
    }

    private final class Session {
        private final WebSocket ws;
        private final ArrayBlockingQueue<Frame> queue = new ArrayBlockingQueue<>(QUEUED_FRAMES);
        private Encoder encoder;
        private Thread sender;
        private volatile boolean closed;
        private volatile boolean waitingForKey;
        private volatile long droppedFrames;
        // Sent by the sender thread, so a stuck connection can never block the watchdog.
        volatile boolean statusDirty = true;
        volatile long lastMessageAt = System.currentTimeMillis();

        Session(WebSocket ws) {
            this.ws = ws;
        }

        /** Called with lock held. */
        void start() throws IOException {
            encoder = new Encoder(options, this::onFrame);
            display.setSurface(encoder.surface());
            sender = new Thread(this::sendLoop, "sender");
            sender.setDaemon(true);
            sender.start();
        }

        private void sendStatus() throws IOException {
            statusDirty = false;
            String json = "{\"displayId\":" + displayId
                    + ",\"width\":" + options.width
                    + ",\"height\":" + options.height
                    + ",\"locked\":" + locked
                    + ",\"usable\":" + isUsable()
                    + ",\"desktop\":" + desktopEligible
                    + ",\"encoder\":\"" + encoder.name() + "\""
                    + ",\"dropped\":" + droppedFrames + "}";
            ws.send(message(TYPE_STATUS, json.getBytes(StandardCharsets.UTF_8)), null);
        }

        private void onFrame(int flags, long captureUs, long encodedUs, byte[] data) {
            boolean config = (flags & Encoder.FLAG_CONFIG) != 0;
            boolean key = (flags & Encoder.FLAG_KEY) != 0;
            if (waitingForKey && !config && !key) {
                return;
            }
            if (key) {
                waitingForKey = false;
            }
            if (!queue.offer(new Frame(flags, captureUs, encodedUs, data))) {
                // The link cannot keep up. Old video is worthless, so skip to a fresh key frame.
                droppedFrames += queue.size() + 1;
                queue.clear();
                waitingForKey = true;
                encoder.requestKeyFrame();
            }
        }

        private void sendLoop() {
            ByteBuffer head = ByteBuffer.allocate(26);
            try {
                while (true) {
                    Frame frame = queue.poll(SENDER_POLL_MS, TimeUnit.MILLISECONDS);
                    if (statusDirty) {
                        sendStatus();
                    }
                    if (frame == null) {
                        continue;
                    }
                    head.clear();
                    head.put((byte) TYPE_VIDEO);
                    head.put((byte) frame.flags);
                    head.putLong(frame.captureUs);
                    head.putLong(frame.encodedUs);
                    head.putLong(System.nanoTime() / 1000);
                    ws.send(head.array(), frame.data);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IOException e) {
                ws.close();
            }
        }

        void readLoop() throws IOException {
            while (true) {
                ByteBuffer m = ByteBuffer.wrap(ws.read());
                lastMessageAt = System.currentTimeMillis();
                int type = m.get() & 0xFF;
                switch (type) {
                    case TYPE_PING:
                        ByteBuffer pong = ByteBuffer.allocate(17);
                        pong.put((byte) TYPE_PONG);
                        pong.putDouble(m.getDouble());
                        pong.putLong(System.nanoTime() / 1000);
                        ws.send(pong.array(), null);
                        break;
                    case TYPE_KEY_FRAME:
                        encoder.requestKeyFrame();
                        break;
                    case TYPE_STOP:
                        new Thread(() -> stop("client asked"), "stop").start();
                        return;
                    default:
                        // Nothing reaches the desktop while the phone is locked, unless opted in.
                        if (isUsable() && !closed) {
                            handleInput(type, m);
                        }
                        break;
                }
            }
        }

        private void handleInput(int type, ByteBuffer m) {
            synchronized (input) {
                switch (type) {
                    case TYPE_MOUSE:
                        int action = m.get();
                        int button = m.get();
                        input.mouse(action, button, clampX(m.getInt()), clampY(m.getInt()));
                        break;
                    case TYPE_SCROLL:
                        input.scroll(clampX(m.getInt()), clampY(m.getInt()), m.getFloat(), m.getFloat());
                        break;
                    case TYPE_KEY:
                        input.key(m.get(), m.getInt(), m.getInt());
                        break;
                    default:
                        Log.info("unknown message type " + type);
                        break;
                }
            }
        }

        private int clampX(int x) {
            return Math.max(0, Math.min(options.width - 1, x));
        }

        private int clampY(int y) {
            return Math.max(0, Math.min(options.height - 1, y));
        }

        /** Called with lock held. */
        void close() {
            if (closed) {
                return;
            }
            closed = true;
            ws.close();
            release();
        }

        /** Called with lock held. Says why first, so the old client stays away instead of taking the session back. */
        void closeAsReplaced() {
            if (closed) {
                return;
            }
            closed = true;
            // On its own thread, because a stuck connection must not hold up the new client.
            Thread farewell = new Thread(() -> {
                try {
                    ws.send(message(TYPE_REPLACED, new byte[0]), null);
                } catch (IOException e) {
                    Log.info("could not tell the old client: " + e.getMessage());
                }
            }, "farewell");
            farewell.setDaemon(true);
            farewell.start();
            ws.closeAfter(FAREWELL_MS);
            release();
        }

        private void release() {
            if (sender != null) {
                sender.interrupt();
            }
            if (input != null) {
                synchronized (input) {
                    input.releaseAll();
                }
            }
            if (display != null) {
                display.setSurface(idleSurface.surface());
            }
            if (encoder != null) {
                encoder.stop();
            }
        }
    }
}
