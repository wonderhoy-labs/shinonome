package com.wonderhoylabs.shinonome.server;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.Point;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
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
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLServerSocketFactory;

/**
 * Runs one desktop session for a browser, and serves the web client over HTTPS. A browser on the
 * network uses a WebSocket. A browser on USB reaches a local socket through adb.
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
	private static final int TYPE_AUDIO = 7;
	private static final int TYPE_CLIPBOARD = 8;
	private static final int TYPE_MOUSE = 16;
	private static final int TYPE_SCROLL = 17;
	private static final int TYPE_KEY = 18;
	private static final int TYPE_PING = 19;
	private static final int TYPE_STOP = 20;
	private static final int TYPE_AUTH_RESPONSE = 21;
	private static final int TYPE_KEY_FRAME = 22;
	private static final int TYPE_RESIZE = 23;
	private static final int TYPE_AUDIO_CONTROL = 24;
	private static final int TYPE_SET_CLIPBOARD = 25;

	private static final int CLIPBOARD_PASTE = 1;

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
	// Once a second, to notice an app that needs sharp mode soon after it opens.
	private static final int DENSITY_CHECK_TICKS = 2;
	private static final int SHELL_TIMEOUT_SECONDS = 10;
	private static final long REOPEN_WAIT_MS = 5_000;
	private static final long REOPEN_POLL_MS = 200;
	private static final long FAREWELL_MS = 500;
	private static final int ELIGIBILITY_CHECK_TICK = 10;
	private static final String NATIVE_SERVER_CLASS = "com.genymobile.scrcpy.Server";
	private static final String USB_SOCKET = "shinonome";
	/** The USB site compares this with its own, and replaces a server it cannot talk to. */
	private static final int USB_PROTOCOL = 2;
	private static final int MAX_HEADER_BYTES = 16 * 1024;
	private static final int MIN_DESKTOP_SIDE = 480;
	private static final int MAX_DESKTOP_SIDE = 2560;
	/**
	 * The phone's screen is tall, and encoders often allow only about 2176 pixels the long way, so the mirror is scaled
	 * down to this. It's still about the phone's own sharpness at the size a browser shows it.
	 */
	private static final int MAX_MIRROR_SIDE = 1920;
	/** How often to check whether the one app is still open, and whether the phone turned. */
	private static final int APP_CHECK_TICKS = 2;
	/**
	 * Sharp mode gives the desktop the phone's own density, which some apps need: React Native ones such as Discord lay
	 * themselves out at the phone's density and draw text at the display's, so any difference clips their text. To keep a
	 * desktop's worth of room it also gets more pixels, as many as it would show at this density: 1.75 times each way at
	 * the Pixel's 420, which took encoding from 9 to 16 ms a frame.
	 */
	private static final int SHARP_ROOM_DPI = 240;
	private static final int MAX_SHARP_SIDE = 3840;
	private static final int RESIZE_SHARP = 1;
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
	/** The density chosen when the server started, which the desktop goes back to when sharp mode ends. */
	private final int baseDpi;
	private final File dir;
	private final SecureRandom random = new SecureRandom();
	private final Object lock = new Object();

	private Map<String, byte[]> webFiles;
	private String pairingCode;
	private ServerSocket serverSocket;
	private LocalServerSocket usbSocket;

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

	/** Null if this phone's clipboard service can't be reached. */
	private Clipboard clipboard;
	// Guarded by clipboardLock. What both sides last agreed the clipboard holds, so a change isn't sent back.
	private final Object clipboardLock = new Object();
	private String clipboardText;

	// Guarded by this.
	private int failedAttempts;
	private long lockedOutUntil;

	private volatile boolean stopping;
	private volatile boolean locked = true;
	private volatile boolean unlockedThisSession;
	private volatile boolean nativeClientAttached;
	private volatile boolean desktopEligible = true;
	private final KeepAlive keepAlive;
	private final DensityNeeds densityNeeds;
	/** The name of the app in front on the desktop if it needs sharp mode and doesn't have it, or null. */
	private volatile String needsSharp;
	/** In {@link Options.Mode#APP}, the app is started once the phone is usable, and again for each new session. */
	private volatile boolean appLaunchWanted = true;
	private volatile boolean appOpen;
	/** In {@link Options.Mode#MIRROR}, the phone's screen size as it's turned now, which input is scaled to. */
	private volatile Point phoneSize = new Point(1, 1);

	Server(Context context, Options options) {
		this.context = context;
		this.options = options;
		this.baseDpi = options.dpi;
		this.dir = new File(options.dir);
		this.keepAlive = new KeepAlive(context);
		this.densityNeeds = new DensityNeeds(context);
	}

	/** Android creates the desktop only after an unlock, and input must not reach a phone locked before that. */
	private boolean isUsable() {
		return !locked || (options.keepRunningLocked && unlockedThisSession);
	}

	void run() throws IOException, GeneralSecurityException {
		// Only a desktop needs Android's desktop windows. The phone's screen and one app work on any Android 17.
		String problem = options.mode == Options.Mode.DESKTOP ? DesktopDisplay.incompatibility(context) : null;
		if (problem != null) {
			Log.info("incompatible: " + problem);
			return;
		}
		if (options.network) {
			openNetworkPort();
		}
		openUsbSocket();
		createDisplay();
		openClipboard();
		Log.info("native: " + nativeCommand(nativeWifiConnection()));
		Log.info("native usb: " + nativeCommand("-d"));
		Log.info("listening");

		Thread watchdog = new Thread(this::watch, "watchdog");
		watchdog.setDaemon(true);
		watchdog.start();
		Thread keeper = new Thread(this::keepPhoneAwake, "keep-awake");
		keeper.setDaemon(true);
		keeper.start();

		Thread usbClients = new Thread(this::acceptUsbClients, "usb-clients");
		usbClients.setDaemon(true);
		usbClients.start();

		if (serverSocket == null) {
			try {
				// stop() ends the process.
				watchdog.join();
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			return;
		}
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

	private void openNetworkPort() throws IOException, GeneralSecurityException {
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
	}

	/**
	 * Any app on the phone could take this name first. The USB site only connects after reading this
	 * server's log, so it can't be fooled that way, and a network session carries on without USB.
	 */
	private void openUsbSocket() throws IOException {
		try {
			usbSocket = new LocalServerSocket(USB_SOCKET);
			Log.info("usb protocol: " + USB_PROTOCOL);
		} catch (IOException e) {
			if (!options.network) {
				throw e;
			}
			Log.info("browsers on USB cannot connect: " + e.getMessage());
		}
	}

	private void acceptUsbClients() {
		while (usbSocket != null && !stopping) {
			try {
				LocalSocket socket = usbSocket.accept();
				new Thread(() -> handleUsb(socket), "usb-client").start();
			} catch (IOException e) {
				Log.error("usb socket failed", e);
				return;
			}
		}
	}

	private void handleUsb(LocalSocket socket) {
		try {
			// adbd runs as the shell user. SELinux stopped an ordinary app reaching this far on the phone
			// we tried, but the session shouldn't rely on every build's policy doing the same.
			int uid = socket.getPeerCredentials().getUid();
			if (uid != Hidden.SHELL_UID) {
				Log.info("refused a local connection from uid " + uid);
				closeQuietly(socket);
				return;
			}
			Link link = new LocalLink(socket);
			link.send(message(TYPE_AUTH_RESULT, new byte[] {AUTH_OK}), null);
			runSession(link);
		} catch (IOException e) {
			Log.info("usb client failed: " + e);
			closeQuietly(socket);
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

	private static void closeQuietly(Closeable socket) {
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

	private void runSession(Link link) throws IOException {
		link.setReadTimeout(0);
		link.setSendBufferSize(SEND_BUFFER_BYTES);
		Session session = new Session(link);
		synchronized (lock) {
			if (stopping) {
				link.close();
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
			int keepRunning = options.keepRunningLocked ? DesktopDisplay.FLAGS_KEEP_RUNNING_LOCKED : 0;
			switch (options.mode) {
				case MIRROR:
					phoneSize = currentPhoneSize();
					int[] size = mirrorSize(phoneSize);
					options.width = size[0];
					options.height = size[1];
					options.dpi = phoneDensity();
					options.fixedSize = true;
					display = DesktopDisplay.mirror(DesktopDisplay.ID_REMOTE_SESSION, options.width, options.height,
							Display.DEFAULT_DISPLAY, idleSurface.surface());
					displayId = display.getDisplay().getDisplayId();
					// Input goes to the phone's own screen, scaled from the mirror's size.
					input = new Input(context, Display.DEFAULT_DISPLAY);
					break;
				case APP:
					display = DesktopDisplay.createWithFlags(manager, DesktopDisplay.ID_ONE_APP, options.width,
							options.height, options.dpi, DesktopDisplay.FLAGS_ONE_APP | keepRunning,
							idleSurface.surface());
					displayId = display.getDisplay().getDisplayId();
					input = new Input(context, displayId);
					Hidden.setImePolicy(displayId, Hidden.DISPLAY_IME_POLICY_HIDE);
					break;
				default:
					display = DesktopDisplay.create(manager, DesktopDisplay.ID_REMOTE_SESSION,
							options.width, options.height, options.dpi, keepRunning, idleSurface.surface());
					displayId = display.getDisplay().getDisplayId();
					input = new Input(context, displayId);
					Hidden.setImePolicy(displayId, Hidden.DISPLAY_IME_POLICY_HIDE);
					break;
			}
			// The library reads this line to tell what a running server shows.
			Log.info("mode: " + modeName() + (options.mode == Options.Mode.APP ? " " + options.app : ""));
			Log.info("display " + displayId + " created");
		} catch (ReflectiveOperationException e) {
			throw new IOException(e);
		}
	}

	private String modeName() {
		return options.mode.name().toLowerCase(java.util.Locale.ROOT);
	}

	@SuppressWarnings("deprecation")
	private Point currentPhoneSize() {
		Point size = new Point();
		phoneDisplay.getRealSize(size);
		return size;
	}

	/** The phone's shape, at most MAX_MIRROR_SIDE the long way, in even numbers for the encoder. */
	private static int[] mirrorSize(Point phone) {
		double scale = Math.min(1, MAX_MIRROR_SIDE / (double) Math.max(phone.x, phone.y));
		return new int[] {(int) Math.round(phone.x * scale) & ~1, (int) Math.round(phone.y * scale) & ~1};
	}

	/**
	 * Called with lock held. Puts the display on this surface. Android sizes a mirror's picture for the surface it was
	 * made with and doesn't look again when the surface changes, so a mirror is made again instead.
	 */
	private void showOn(Surface surface) throws IOException {
		if (options.mode != Options.Mode.MIRROR) {
			display.setSurface(surface);
			return;
		}
		VirtualDisplay old = display;
		try {
			display = DesktopDisplay.mirror(DesktopDisplay.ID_REMOTE_SESSION, options.width, options.height,
					Display.DEFAULT_DISPLAY, surface);
		} catch (ReflectiveOperationException e) {
			throw new IOException(e);
		}
		displayId = display.getDisplay().getDisplayId();
		old.release();
	}

	/** Called with lock held, when the phone turns: the mirror takes the new shape. */
	private void followPhoneRotation() {
		Point now = currentPhoneSize();
		Point before = phoneSize;
		if (now.x == before.x && now.y == before.y) {
			return;
		}
		phoneSize = now;
		int[] size = mirrorSize(now);
		Log.info("phone turned, mirror is now " + size[0] + "x" + size[1]);
		if (current != null) {
			current.applySize(size[0], size[1], options.dpi);
		} else {
			// Made again for the next session's surface, at the size it has then.
			options.width = size[0];
			options.height = size[1];
		}
	}

	/** Opens the one app on its display. Not called with lock held, because it waits for `am`. */
	private void launchApp() {
		String id = String.valueOf(displayId);
		Log.info("opening " + options.app);
		if (options.app.contains("://")) {
			runShell("am", "start", "--display", id, "-a", "android.intent.action.VIEW", "-d", options.app);
		} else {
			runShell("am", "start", "--display", id, "-n", options.app);
		}
	}

	/** The phone screen's density, including any display size someone chose in Settings. */
	@SuppressWarnings("deprecation")
	private int phoneDensity() {
		DisplayMetrics metrics = new DisplayMetrics();
		phoneDisplay.getRealMetrics(metrics);
		return metrics.densityDpi;
	}

	private void openClipboard() {
		try {
			Clipboard opened = Clipboard.open(context);
			opened.listen(this::onClipboardChanged);
			clipboard = opened;
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.info("clipboard unavailable: " + e);
		}
	}

	/** On a binder thread. Hands the phone's new clipboard to the browser, unless the browser put it there. */
	private void onClipboardChanged() {
		String text = clipboard.text();
		synchronized (clipboardLock) {
			if (text == null || text.equals(clipboardText)) {
				return;
			}
			clipboardText = text;
		}
		Session session;
		synchronized (lock) {
			session = current;
		}
		if (session != null) {
			session.offerClipboard(text);
		}
	}

	/** Puts the browser's clipboard on the phone, and pastes it if asked. Called with input held. */
	private void setClipboard(String text, boolean paste) {
		synchronized (clipboardLock) {
			clipboardText = text;
		}
		if (clipboard != null && clipboard.setText(text) && paste) {
			input.paste();
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
	/**
	 * Notes the app in front on the desktop if it needs sharp mode, and sharp mode is off, so the page can offer it.
	 * Returns whether that changed. Nothing changes while the phone's own screen has the focus.
	 */
	private boolean checkDensityNeeds() {
		int id;
		synchronized (lock) {
			if (current == null) {
				return false;
			}
			id = displayId;
		}
		Hidden.ForegroundTask task = Hidden.foregroundTask();
		if (task == null || task.displayId != id) {
			return false;
		}
		String app = null;
		ComponentName top = ComponentName.unflattenFromString(task.activity);
		if (task.isOrdinaryApp && top != null && options.dpi != phoneDensity()
				&& densityNeeds.needsPhoneDensity(top.getPackageName())) {
			app = densityNeeds.label(top.getPackageName());
		}
		if (Objects.equals(app, needsSharp)) {
			return false;
		}
		needsSharp = app;
		return true;
	}

	/** The windows of the desktop's apps that need sharp mode, to restart once it's on. */
	private List<Hidden.DisplayTask> densityTasks(int id) {
		List<Hidden.DisplayTask> needing = new ArrayList<>();
		List<String> seen = new ArrayList<>();
		for (Hidden.DisplayTask task : Hidden.tasksOnDisplay(id)) {
			// Restarting an app restarts all its windows, so one each.
			if (!seen.contains(task.packageName) && densityNeeds.needsPhoneDensity(task.packageName)) {
				seen.add(task.packageName);
				needing.add(task);
			}
		}
		return needing;
	}

	/**
	 * Restarts apps that need sharp mode, because they only take up the new density from a fresh start. Each window
	 * goes back where it was, scaled to the desktop's new size. It's what someone would otherwise do by hand, and it
	 * closes whatever they had open in those apps.
	 */
	private void reopenForSharpMode(int id, List<Hidden.DisplayTask> tasks, double scaleX, double scaleY) {
		if (tasks.isEmpty()) {
			return;
		}
		Thread thread = new Thread(() -> {
			for (Hidden.DisplayTask task : tasks) {
				ComponentName launcher = densityNeeds.launcher(task.packageName);
				if (launcher == null) {
					continue;
				}
				Log.info("reopening " + task.packageName + " for sharp mode");
				runShell("am", "force-stop", task.packageName);
				runShell("am", "start", "--display", String.valueOf(id), "-n", launcher.flattenToShortString());
				if (task.bounds != null) {
					restoreBounds(id, task.packageName, new Rect(
							(int) Math.round(task.bounds.left * scaleX), (int) Math.round(task.bounds.top * scaleY),
							(int) Math.round(task.bounds.right * scaleX), (int) Math.round(task.bounds.bottom * scaleY)));
				}
			}
		}, "reopen");
		thread.setDaemon(true);
		thread.start();
	}

	/** Puts a restarted app's window where it was, once it has one. */
	private static void restoreBounds(int id, String packageName, Rect bounds) {
		long deadline = System.currentTimeMillis() + REOPEN_WAIT_MS;
		while (System.currentTimeMillis() < deadline) {
			for (Hidden.DisplayTask task : Hidden.tasksOnDisplay(id)) {
				if (task.packageName.equals(packageName)) {
					runShell("cmd", "activity", "task", "resize", String.valueOf(task.taskId),
							String.valueOf(bounds.left), String.valueOf(bounds.top),
							String.valueOf(bounds.right), String.valueOf(bounds.bottom));
					return;
				}
			}
			try {
				Thread.sleep(REOPEN_POLL_MS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
		}
		Log.info(packageName + " didn't open a window to put back");
	}

	private static void runShell(String... command) {
		try {
			Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
			if (!process.waitFor(SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
				process.destroy();
				Log.info("timed out: " + String.join(" ", command));
			}
		} catch (IOException e) {
			Log.error("could not run " + String.join(" ", command), e);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

	/** A JSON string, or null. */
	static String jsonString(String text) {
		if (text == null) {
			return "null";
		}
		StringBuilder out = new StringBuilder("\"");
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if (c == '"' || c == '\\') {
				out.append('\\').append(c);
			} else if (c < 0x20) {
				out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
			} else {
				out.append(c);
			}
		}
		return out.append('"').toString();
	}

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
			if (tick % DENSITY_CHECK_TICKS == 0 && checkDensityNeeds()) {
				changed = true;
			}
			if (options.mode == Options.Mode.APP && tick % APP_CHECK_TICKS == 0) {
				boolean open = !Hidden.tasksOnDisplay(displayId).isEmpty();
				if (open != appOpen) {
					appOpen = open;
					changed = true;
				}
				if (appLaunchWanted && hasClient() && isUsable()) {
					appLaunchWanted = false;
					launchApp();
				}
			}
			if (options.mode == Options.Mode.MIRROR && tick % APP_CHECK_TICKS == 0) {
				synchronized (lock) {
					followPhoneRotation();
				}
			}
			if (tick == ELIGIBILITY_CHECK_TICK && options.mode == Options.Mode.DESKTOP) {
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
			// Lock first, so it happens even if something kills the server while the rest closes. The phone would
			// otherwise stay awake with its screen dark, which takes the power button and the PIN to get out of.
			if (panelDark || Hidden.isKeyguardLocked()) {
				lockPhone();
				Log.info("phone locked");
			}
			if (current != null) {
				current.close();
				current = null;
			}
			if (display != null) {
				try {
					display.release();
				} catch (RuntimeException e) {
					// Exiting releases the display anyway.
					Log.error("could not release the display", e);
				}
				display = null;
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
		private final Link link;
		private final ArrayBlockingQueue<Frame> queue = new ArrayBlockingQueue<>(QUEUED_FRAMES);
		private volatile Encoder encoder;
		private Thread sender;
		private volatile boolean closed;
		private volatile boolean waitingForKey;
		private volatile long droppedFrames;
		private AudioCapture audio;
		private volatile String audioState = "off";
		// Sent by the sender thread, which never blocks the binder thread the clipboard arrives on.
		private volatile String pendingClipboard;
		// Sent by the sender thread, so a stuck connection can never block the watchdog.
		volatile boolean statusDirty = true;
		volatile long lastMessageAt = System.currentTimeMillis();

		Session(Link link) {
			this.link = link;
		}

		/** Called with lock held. */
		void start() throws IOException {
			// A new session opens the one app again if it was closed.
			appLaunchWanted = true;
			encoder = new Encoder(options, this::onFrame);
			showOn(encoder.surface());
			sender = new Thread(this::sendLoop, "sender");
			sender.setDaemon(true);
			sender.start();
		}

		private void sendStatus() throws IOException {
			statusDirty = false;
			String json = "{\"displayId\":" + displayId
					+ ",\"width\":" + options.width
					+ ",\"height\":" + options.height
					+ ",\"dpi\":" + options.dpi
					+ ",\"locked\":" + locked
					+ ",\"usable\":" + isUsable()
					+ ",\"desktop\":" + desktopEligible
					+ ",\"encoder\":\"" + encoder.name() + "\""
					+ ",\"audio\":\"" + audioState + "\""
					+ ",\"clipboard\":" + (clipboard != null)
					+ ",\"needsSharp\":" + jsonString(needsSharp)
					+ ",\"dropped\":" + droppedFrames
					+ ",\"mode\":\"" + modeName() + "\""
					+ ",\"appOpen\":" + appOpen + "}";
			link.send(message(TYPE_STATUS, json.getBytes(StandardCharsets.UTF_8)), null);
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
					String text = pendingClipboard;
					if (text != null) {
						pendingClipboard = null;
						link.send(new byte[] {TYPE_CLIPBOARD}, text.getBytes(StandardCharsets.UTF_8));
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
					link.send(head.array(), frame.data);
				}
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			} catch (IOException e) {
				link.close();
			}
		}

		void readLoop() throws IOException {
			while (true) {
				ByteBuffer m = ByteBuffer.wrap(link.read());
				lastMessageAt = System.currentTimeMillis();
				int type = m.get() & 0xFF;
				switch (type) {
					case TYPE_PING:
						ByteBuffer pong = ByteBuffer.allocate(17);
						pong.put((byte) TYPE_PONG);
						pong.putDouble(m.getDouble());
						pong.putLong(System.nanoTime() / 1000);
						link.send(pong.array(), null);
						break;
					case TYPE_KEY_FRAME:
						encoder.requestKeyFrame();
						break;
					case TYPE_RESIZE:
						int width = m.getInt();
						int height = m.getInt();
						// Clients from before sharp mode send no flags.
						boolean sharp = m.hasRemaining() && (m.get() & RESIZE_SHARP) != 0;
						resize(width, height, sharp);
						break;
					case TYPE_AUDIO_CONTROL:
						setAudio(m.get() != 0);
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

		void offerClipboard(String text) {
			pendingClipboard = text;
		}

		/** Moves the phone's sound to the browser, or back to the phone. */
		private void setAudio(boolean on) {
			synchronized (lock) {
				if (closed || on == (audio != null)) {
					return;
				}
				if (!on) {
					audio.stop();
					audio = null;
					audioState = "off";
					Log.info("audio back on the phone");
				} else {
					try {
						audio = new AudioCapture(context, new AudioCapture.Sink() {
							@Override
							public void onAudio(long captureUs, byte[] pcm) {
								sendAudio(captureUs, pcm);
							}

							@Override
							public void onAudioFailed(String reason) {
								Log.info(reason);
								audioState = "failed";
								statusDirty = true;
							}
						});
						audioState = "on";
						Log.info("audio to the browser");
					} catch (IOException e) {
						Log.info(e.getMessage());
						audioState = "failed";
					}
				}
				statusDirty = true;
			}
		}

		private void sendAudio(long captureUs, byte[] pcm) {
			ByteBuffer head = ByteBuffer.allocate(9);
			head.put((byte) TYPE_AUDIO);
			head.putLong(captureUs);
			try {
				link.send(head.array(), pcm);
			} catch (IOException e) {
				link.close();
			}
		}

		/**
		 * Gives the desktop the shape of the browser's window, so the picture fills it with no bars. In sharp mode it
		 * also takes the phone's density, with more pixels to match.
		 */
		private void resize(int width, int height, boolean sharp) throws IOException {
			int newWidth = desktopSide(width);
			int newHeight = desktopSide(height);
			int newDpi = baseDpi;
			int id;
			boolean turnedSharp;
			List<Hidden.DisplayTask> reopen;
			double scaleX;
			double scaleY;
			if (sharp) {
				newDpi = phoneDensity();
				double scale = Math.max(1, newDpi / (double) SHARP_ROOM_DPI);
				scale = Math.min(scale, MAX_SHARP_SIDE / (double) Math.max(newWidth, newHeight));
				newWidth = (int) Math.round(newWidth * scale) & ~1;
				newHeight = (int) Math.round(newHeight * scale) & ~1;
			}
			synchronized (lock) {
				if (options.fixedSize || closed
						|| (newWidth == options.width && newHeight == options.height && newDpi == options.dpi)) {
					return;
				}
				Log.info("desktop resized to " + newWidth + "x" + newHeight + " at " + newDpi + " dpi");
				turnedSharp = newDpi != options.dpi && newDpi != baseDpi;
				id = displayId;
				// Where they are before the desktop changes size.
				reopen = turnedSharp ? densityTasks(id) : List.of();
				scaleX = newWidth / (double) options.width;
				scaleY = newHeight / (double) options.height;
				applySize(newWidth, newHeight, newDpi);
				if (turnedSharp) {
					// The app that needed it has it now.
					needsSharp = null;
				}
			}
			// Only when the density changes, not when sharp mode follows the browser window to a new size.
			if (turnedSharp) {
				reopenForSharpMode(id, reopen, scaleX, scaleY);
			}
		}

		/** Called with lock held. Gives the display and the encoder a new size. */
		void applySize(int width, int height, int dpi) {
			if (closed) {
				return;
			}
			display.setSurface(idleSurface.surface());
			encoder.stop();
			queue.clear();
			options.width = width;
			options.height = height;
			options.dpi = dpi;
			if (options.mode != Options.Mode.MIRROR) {
				display.resize(width, height, dpi);
			}
			try {
				encoder = new Encoder(options, this::onFrame);
				showOn(encoder.surface());
			} catch (IOException e) {
				Log.error("could not restart the encoder", e);
				link.close();
				return;
			}
			statusDirty = true;
		}

		/** Encoders need even numbers. */
		private int desktopSide(int side) {
			return Math.max(MIN_DESKTOP_SIDE, Math.min(MAX_DESKTOP_SIDE, side)) & ~1;
		}

		private void handleInput(int type, ByteBuffer m) {
			synchronized (input) {
				switch (type) {
					case TYPE_MOUSE:
						int action = m.get();
						int button = m.get();
						input.mouse(action, button, toPhoneX(clampX(m.getInt())), toPhoneY(clampY(m.getInt())));
						break;
					case TYPE_SCROLL:
						input.scroll(toPhoneX(clampX(m.getInt())), toPhoneY(clampY(m.getInt())), m.getFloat(),
								m.getFloat());
						break;
					case TYPE_KEY:
						input.key(m.get(), m.getInt(), m.getInt());
						break;
					case TYPE_SET_CLIPBOARD:
						boolean paste = (m.get() & CLIPBOARD_PASTE) != 0;
						byte[] text = new byte[m.remaining()];
						m.get(text);
						setClipboard(new String(text, StandardCharsets.UTF_8), paste);
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

		/** A mirror is smaller than the phone's screen, which is where its input goes. */
		private int toPhoneX(int x) {
			return options.mode == Options.Mode.MIRROR ? (int) ((long) x * phoneSize.x / options.width) : x;
		}

		private int toPhoneY(int y) {
			return options.mode == Options.Mode.MIRROR ? (int) ((long) y * phoneSize.y / options.height) : y;
		}

		/** Called with lock held. */
		void close() {
			if (closed) {
				return;
			}
			closed = true;
			link.close();
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
					link.send(message(TYPE_REPLACED, new byte[0]), null);
				} catch (IOException e) {
					Log.info("could not tell the old client: " + e.getMessage());
				}
			}, "farewell");
			farewell.setDaemon(true);
			farewell.start();
			link.closeAfter(FAREWELL_MS);
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
			if (audio != null) {
				audio.stop();
				audio = null;
			}
		}
	}
}
