package com.wonderhoylabs.shinonome

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import java.io.File
import java.util.concurrent.Executors
import rikka.shizuku.Shizuku

/**
 * The app's one screen: opens the desktop on this phone, or starts a session for a computer. Both run
 * as the shell user through Shizuku, and a session can also be started from a computer with adb.
 */
class MainActivity : Activity() {

    private val background = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var details: View
    private lateinit var address: TextView
    private lateinit var code: TextView
    private lateinit var nativeCommand: TextView
    private var running = false

    private val permissionListener = Shizuku.OnRequestPermissionResultListener { _, result ->
        if (result == PackageManager.PERMISSION_GRANTED) {
            start()
        } else {
            status.setText(R.string.shizuku_denied)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        toggle = findViewById(R.id.toggle)
        details = findViewById(R.id.details)
        address = findViewById(R.id.address)
        code = findViewById(R.id.code)
        nativeCommand = findViewById(R.id.native_command)
        toggle.setOnClickListener { if (running) stop() else requestStart() }
        findViewById<Button>(R.id.open_desktop).setOnClickListener {
            startActivity(Intent(this, DesktopActivity::class.java))
        }
        findViewById<Button>(R.id.end_desktop).setOnClickListener { endDesktop() }
        Shizuku.addRequestPermissionResultListener(permissionListener)
        background.execute { publishScriptsForAdb() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onDestroy() {
        Shizuku.removeRequestPermissionResultListener(permissionListener)
        background.shutdown()
        super.onDestroy()
    }

    /** Lets someone without Shizuku start a session with one adb command, the same on any computer. */
    private fun publishScriptsForAdb() {
        val directory = getExternalFilesDir(null) ?: return
        for (name in listOf(START_SCRIPT, STOP_SCRIPT)) {
            assets.open(name).use { input ->
                File(directory, name).outputStream().use { output -> input.copyTo(output) }
            }
        }
    }

    private fun adbStartPath(): String =
        File(getExternalFilesDir(null), START_SCRIPT).path.replace("/storage/emulated/0", "/sdcard")

    private fun requestStart() {
        background.execute {
            val available = Shell.awaitAvailable()
            runOnUiThread {
                when {
                    !available -> status.text = getString(R.string.shizuku_missing, adbStartPath())
                    Shell.hasPermission() -> start()
                    else -> Shizuku.requestPermission(PERMISSION_REQUEST)
                }
            }
        }
    }

    private fun start() {
        status.setText(R.string.status_starting)
        toggle.isEnabled = false
        background.execute {
            val script = assets.open(START_SCRIPT).bufferedReader().use { it.readText() }
            val output = runCatching {
                // Android leaves a second virtual desktop without title bars, so only one can run.
                Shell.get(applicationContext).endDesktop()
                shell(script)
            }
            runOnUiThread {
                toggle.isEnabled = true
                output.onSuccess { show(it) }
                output.onFailure { status.text = getString(R.string.status_failed, it.message) }
            }
        }
    }

    private fun stop() {
        toggle.isEnabled = false
        background.execute {
            val script = assets.open(STOP_SCRIPT).bufferedReader().use { it.readText() }
            val result = runCatching { shell(script) }
            runOnUiThread {
                toggle.isEnabled = true
                running = false
                toggle.setText(R.string.start)
                details.visibility = View.GONE
                result.onSuccess { status.setText(R.string.status_ended) }
                result.onFailure { status.text = getString(R.string.status_failed, it.message) }
            }
        }
    }

    private fun endDesktop() {
        if (!Shell.hasPermission()) {
            return
        }
        background.execute {
            runCatching { Shell.get(applicationContext).endDesktop() }
        }
    }

    /** Picks up a session that is already running, so reopening the app still shows how to connect. */
    private fun refresh() {
        background.execute {
            if (!Shell.awaitAvailable() || !Shell.hasPermission()) {
                return@execute
            }
            val log = runCatching {
                shell("pidof shinonome-server >/dev/null && cat /data/local/tmp/shinonome/server.log")
            }.getOrDefault("")
            runOnUiThread { if (log.isNotBlank()) show(log) else showIdle() }
        }
    }

    private fun showIdle() {
        running = false
        toggle.setText(R.string.start)
        details.visibility = View.GONE
    }

    private fun show(log: String) {
        val lines = log.lines()
        val failure = lines.firstOrNull { it.startsWith("incompatible:") }
        if (failure != null) {
            showIdle()
            status.text = failure.removePrefix("incompatible:").trim()
            return
        }
        val urls = lines.filter { it.startsWith("url: ") }.map { it.removePrefix("url: ") }
        val pairingCode = lines.firstOrNull { it.startsWith("pairing code: ") }?.removePrefix("pairing code: ")
        if (pairingCode == null) {
            showIdle()
            status.text = getString(R.string.status_failed, log.trim().ifEmpty { "no output" })
            return
        }
        running = true
        toggle.setText(R.string.end)
        status.setText(R.string.status_running)
        address.text = urls.joinToString("\n")
        code.text = pairingCode
        nativeCommand.text = getString(
            R.string.native_commands,
            lines.firstOrNull { it.startsWith(NATIVE_WIFI_PREFIX) }?.removePrefix(NATIVE_WIFI_PREFIX) ?: "",
            lines.firstOrNull { it.startsWith(NATIVE_USB_PREFIX) }?.removePrefix(NATIVE_USB_PREFIX) ?: "",
        )
        details.visibility = View.VISIBLE
    }

    private fun shell(script: String): String = Shell.get(applicationContext).run(script)

    private companion object {
        const val PERMISSION_REQUEST = 1
        const val START_SCRIPT = "start.sh"
        const val STOP_SCRIPT = "stop.sh"
        const val NATIVE_WIFI_PREFIX = "native: "
        const val NATIVE_USB_PREFIX = "native usb: "
    }
}
