package com.wonderhoylabs.shinonome

import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import kotlin.system.exitProcess
import com.wonderhoylabs.shinonome.server.AppDesktop

/** Runs in a separate process that Shizuku starts as the shell user. */
class ShellService : IShell.Stub() {

    private val desktop by lazy { AppDesktop() }

    override fun run(script: String): String {
        val process = ProcessBuilder("sh", "-c", script).redirectErrorStream(true).start()
        process.outputStream.close()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        process.waitFor()
        return output
    }

    override fun attachDesktop(surface: Surface, width: Int, height: Int, dpi: Int): Int =
        desktop.attach(surface, width, height, dpi)

    override fun detachDesktop() {
        desktop.detach()
    }

    override fun endDesktop() {
        desktop.end()
    }

    override fun adoptForegroundApp(desktopActivity: String): Boolean =
        desktop.adoptForegroundApp(desktopActivity)

    override fun isDesktopEligible(): Boolean = desktop.isEligible()

    override fun injectMotion(event: MotionEvent, actionButton: Int) {
        desktop.injectEvent(event, actionButton)
    }

    override fun injectKey(event: KeyEvent) {
        desktop.injectEvent(event, 0)
    }

    override fun destroy() {
        exitProcess(0)
    }
}
