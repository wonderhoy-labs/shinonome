package com.wonderhoylabs.shinonome

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The connection to [ShellService]. The service outlives any one screen of the app, so a desktop
 * keeps running when the app is closed.
 */
object Shell {

	private const val TIMEOUT_SECONDS = 15L

	// Shizuku restarts the service when this changes, so raise it when ShellService changes.
	private const val SERVICE_VERSION = 5

	private const val BINDER_WAIT_MS = 3000L
	private const val BINDER_POLL_MS = 100L

	@Volatile private var service: IShell? = null

	@Volatile private var ready: CountDownLatch? = null

	private val connection = object : ServiceConnection {
		override fun onServiceConnected(name: ComponentName, binder: IBinder?) {
			service = binder?.takeIf { it.pingBinder() }?.let { IShell.Stub.asInterface(it) }
			ready?.countDown()
		}

		override fun onServiceDisconnected(name: ComponentName) {
			service = null
		}
	}

	fun isAvailable(): Boolean = Shizuku.pingBinder() && !Shizuku.isPreV11()

	fun hasPermission(): Boolean = isAvailable() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED

	/**
	 * Shizuku reaches a new process a moment after it starts, so checking straight away can wrongly
	 * report that it isn't running. Call on a background thread.
	 */
	fun awaitAvailable(): Boolean {
		val deadline = SystemClock.uptimeMillis() + BINDER_WAIT_MS
		while (!isAvailable() && SystemClock.uptimeMillis() < deadline) {
			SystemClock.sleep(BINDER_POLL_MS)
		}
		return isAvailable()
	}

	/** Call on a background thread: binding happens on the main thread and this waits for it. */
	fun get(context: Context): IShell {
		service?.let { return it }
		val latch = CountDownLatch(1)
		ready = latch
		val args = Shizuku.UserServiceArgs(ComponentName(context.packageName, ShellService::class.java.name))
			.processNameSuffix("shell")
			.version(SERVICE_VERSION)
			.daemon(true)
		Handler(Looper.getMainLooper()).post { Shizuku.bindUserService(args, connection) }
		check(latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "Shizuku did not start the helper" }
		return checkNotNull(service) { "The helper stopped" }
	}
}
