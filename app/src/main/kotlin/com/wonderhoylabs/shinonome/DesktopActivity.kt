package com.wonderhoylabs.shinonome

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Toast
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt
import rikka.shizuku.Shizuku

/**
 * Android's desktop mode, in an app on the phone itself. The desktop draws directly onto this
 * screen's surface, and touch, mouse and keyboard input are passed through to it.
 */
class DesktopActivity : Activity(), SurfaceHolder.Callback {

    private val background = Executors.newSingleThreadExecutor()
    private lateinit var surfaceView: SurfaceView

    @Volatile private var shell: IShell? = null

    // Starting a session for a computer stops the helper, because only one desktop can run.
    private val helperStopped = IBinder.DeathRecipient {
        runOnUiThread { finishWithMessage(getString(R.string.desktop_helper_stopped)) }
    }

    private val permissionListener = Shizuku.OnRequestPermissionResultListener { _, result ->
        if (result == PackageManager.PERMISSION_GRANTED) {
            attachIfReady()
        } else {
            finishWithMessage(getString(R.string.shizuku_denied))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        surfaceView = SurfaceView(this)
        surfaceView.holder.addCallback(this)
        setContentView(surfaceView)
        Shizuku.addRequestPermissionResultListener(permissionListener)
        background.execute {
            val available = Shell.awaitAvailable()
            runOnUiThread {
                when {
                    isDestroyed -> Unit
                    !available -> {
                        finishWithMessage(getString(R.string.desktop_needs_shizuku))
                        startActivity(Intent(this, MainActivity::class.java))
                    }
                    !Shell.hasPermission() -> Shizuku.requestPermission(PERMISSION_REQUEST)
                    else -> attachIfReady()
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            val controller = window.insetsController ?: return
            controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsets.Type.systemBars())
        }
    }

    /**
     * An app opened from outside the desktop, such as from a notification, lands on the phone's own
     * screen and covers this one. Pull it into the desktop and come back to the front.
     */
    override fun onPause() {
        super.onPause()
        val service = shell ?: return
        val own = componentName.flattenToString()
        background.execute {
            val moved = runCatching { service.adoptForegroundApp(own) }.getOrDefault(false)
            if (moved) {
                runCatching { service.run("am start -n $own") }
            }
        }
    }

    override fun onDestroy() {
        Shizuku.removeRequestPermissionResultListener(permissionListener)
        // Throws if the helper has already stopped, which is fine here.
        runCatching { shell?.asBinder()?.unlinkToDeath(helperStopped, 0) }
        background.shutdown()
        super.onDestroy()
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        attachIfReady()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        // Must finish before this returns, because the surface is gone afterwards.
        val current = shell ?: return
        runCatching { current.detachDesktop() }
    }

    private fun attachIfReady() {
        val holder = surfaceView.holder
        val frame = holder.surfaceFrame
        if (!Shell.hasPermission() || holder.surface?.isValid != true || frame.width() <= 0) {
            return
        }
        val width = frame.width()
        val height = frame.height()
        // The lock screen briefly forces portrait. Resizing the desktop to match would shuffle its windows.
        if (height > width) {
            return
        }
        val dpi = desktopDpi()
        background.execute {
            val result = runCatching {
                val service = Shell.get(applicationContext)
                check(service.run(SERVER_RUNNING_CHECK).isBlank()) { getString(R.string.desktop_server_running) }
                service.attachDesktop(holder.surface, width, height, dpi)
                if (shell == null) {
                    service.asBinder().linkToDeath(helperStopped, 0)
                    surfaceView.postDelayed({ warnIfNotDesktop(service) }, ELIGIBILITY_CHECK_MS)
                }
                shell = service
            }
            result.onFailure { error -> runOnUiThread { finishWithMessage(error.message ?: error.toString()) } }
        }
    }

    /** Without this, a phone that cannot host the desktop shows only an empty screen and no reason why. */
    private fun warnIfNotDesktop(service: IShell) {
        if (isDestroyed) {
            return
        }
        background.execute {
            val eligible = runCatching { service.isDesktopEligible }.getOrDefault(true)
            if (!eligible) {
                runOnUiThread { Toast.makeText(this, R.string.desktop_not_eligible, Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** Scales the phone's density down, so desktop windows fit on a phone-sized screen. */
    private fun desktopDpi(): Int =
        max(MIN_DESKTOP_DPI, (resources.displayMetrics.densityDpi * DESKTOP_DENSITY_SCALE).roundToInt())

    private fun finishWithMessage(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        forwardMotion(event)
        return true
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        forwardMotion(event)
        return true
    }

    /**
     * Rebuilds the event in this view's coordinates, because the original carries the phone's
     * rotation and the desktop has none.
     */
    private fun forwardMotion(event: MotionEvent) {
        val service = shell ?: return
        val count = event.pointerCount
        val properties = Array(count) { MotionEvent.PointerProperties().also { p -> event.getPointerProperties(it, p) } }
        val coords = Array(count) { MotionEvent.PointerCoords().also { c -> event.getPointerCoords(it, c) } }
        val copy = MotionEvent.obtain(
            event.downTime, event.eventTime, event.action, count, properties, coords,
            event.metaState, event.buttonState, 1f, 1f, event.deviceId, event.edgeFlags, event.source, 0,
        )
        runCatching { service.injectMotion(copy, event.actionButton) }
        copy.recycle()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val service = shell
        if (service == null || event.keyCode in SYSTEM_KEYS) {
            return super.dispatchKeyEvent(event)
        }
        runCatching { service.injectKey(KeyEvent(event).also { it.source = event.source }) }
        return true
    }

    private companion object {
        const val PERMISSION_REQUEST = 2
        const val MIN_DESKTOP_DPI = 160
        const val DESKTOP_DENSITY_SCALE = 4f / 7f
        const val SERVER_RUNNING_CHECK = "pidof shinonome-server"
        const val ELIGIBILITY_CHECK_MS = 3000L
        val SYSTEM_KEYS = setOf(
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_VOLUME_MUTE,
            KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_HOME,
        )
    }
}
