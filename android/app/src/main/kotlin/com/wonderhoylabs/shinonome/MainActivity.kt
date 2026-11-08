package com.wonderhoylabs.shinonome

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.wonderhoylabs.shinonome.ui.BrandFooter
import com.wonderhoylabs.shinonome.ui.BrandHeader
import com.wonderhoylabs.shinonome.ui.ShinonomeTheme
import rikka.shizuku.Shizuku
import java.io.File
import java.util.concurrent.Executors

/**
 * The app's one screen: opens the desktop on this phone, or starts a session for a computer. Both run
 * as the shell user through Shizuku, and a session can also be started from a computer with adb.
 */
class MainActivity : ComponentActivity() {
	private val background = Executors.newSingleThreadExecutor()

	private var status by mutableStateOf<String?>(null)
	private var running by mutableStateOf(false)
	private var busy by mutableStateOf(false)
	private var session by mutableStateOf<Session?>(null)

	/** How a computer connects to a running session. */
	private data class Session(val addresses: String, val pairingCode: String, val nativeCommands: String)

	private val permissionListener =
		Shizuku.OnRequestPermissionResultListener { _, result ->
			if (result == PackageManager.PERMISSION_GRANTED) {
				start()
			} else {
				status = getString(R.string.shizuku_denied)
			}
		}

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge()
		super.onCreate(savedInstanceState)
		setContent {
			ShinonomeTheme {
				Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
					MainScreen(
						status = status ?: stringResource(R.string.status_idle),
						running = running,
						busy = busy,
						session = session,
						onOpenDesktop = { startActivity(Intent(this, DesktopActivity::class.java)) },
						onEndDesktop = ::endDesktop,
						onToggle = { if (running) stop() else requestStart() },
					)
				}
			}
		}
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
					!available -> status = getString(R.string.shizuku_missing, adbStartPath())
					Shell.hasPermission() -> start()
					else -> Shizuku.requestPermission(PERMISSION_REQUEST)
				}
			}
		}
	}

	private fun start() {
		status = getString(R.string.status_starting)
		busy = true
		background.execute {
			val script = assets.open(START_SCRIPT).bufferedReader().use { it.readText() }
			val output =
				runCatching {
					// Android leaves a second virtual desktop without title bars, so only one can run.
					Shell.get(applicationContext).endDesktop()
					shell(script)
				}
			runOnUiThread {
				busy = false
				output.onSuccess { show(it) }
				output.onFailure { status = getString(R.string.status_failed, it.message) }
			}
		}
	}

	private fun stop() {
		busy = true
		background.execute {
			val script = assets.open(STOP_SCRIPT).bufferedReader().use { it.readText() }
			val result = runCatching { shell(script) }
			runOnUiThread {
				busy = false
				running = false
				session = null
				result.onSuccess { status = getString(R.string.status_ended) }
				result.onFailure { status = getString(R.string.status_failed, it.message) }
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
			val log =
				runCatching {
					shell("pidof shinonome-server >/dev/null && cat /data/local/tmp/shinonome/server.log")
				}.getOrDefault("")
			runOnUiThread { if (log.isNotBlank()) show(log) else showIdle() }
		}
	}

	private fun showIdle() {
		running = false
		session = null
	}

	private fun show(log: String) {
		val lines = log.lines()
		val failure = lines.firstOrNull { it.startsWith("incompatible:") }
		if (failure != null) {
			showIdle()
			status = failure.removePrefix("incompatible:").trim()
			return
		}
		val urls = lines.filter { it.startsWith("url: ") }.map { it.removePrefix("url: ") }
		val pairingCode = lines.firstOrNull { it.startsWith("pairing code: ") }?.removePrefix("pairing code: ")
		if (pairingCode == null) {
			showIdle()
			status = getString(R.string.status_failed, log.trim().ifEmpty { "no output" })
			return
		}
		running = true
		status = getString(R.string.status_running)
		session =
			Session(
				addresses = urls.joinToString("\n"),
				pairingCode = pairingCode,
				nativeCommands =
					getString(
						R.string.native_commands,
						lines.firstOrNull { it.startsWith(NATIVE_WIFI_PREFIX) }?.removePrefix(NATIVE_WIFI_PREFIX) ?: "",
						lines.firstOrNull { it.startsWith(NATIVE_USB_PREFIX) }?.removePrefix(NATIVE_USB_PREFIX) ?: "",
					),
			)
	}

	private fun shell(script: String): String = Shell.get(applicationContext).run(script)

	@Composable
	private fun MainScreen(
		status: String,
		running: Boolean,
		busy: Boolean,
		session: Session?,
		onOpenDesktop: () -> Unit,
		onEndDesktop: () -> Unit,
		onToggle: () -> Unit,
	) {
		Box(
			modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).safeDrawingPadding(),
			contentAlignment = Alignment.TopCenter,
		) {
			Column(
				modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(horizontal = 20.dp, vertical = 24.dp),
				verticalArrangement = Arrangement.spacedBy(16.dp),
			) {
				BrandHeader(subtitle = stringResource(R.string.tagline), logo = painterResource(R.drawable.logo))
				Section(title = stringResource(R.string.section_phone)) {
					Button(onClick = onOpenDesktop, modifier = Modifier.fillMaxWidth()) {
						Text(stringResource(R.string.open_desktop))
					}
					OutlinedButton(onClick = onEndDesktop, modifier = Modifier.fillMaxWidth()) {
						Text(stringResource(R.string.end_desktop))
					}
				}
				Section(title = stringResource(R.string.section_computer), highlighted = running) {
					SelectionContainer { Text(status, style = MaterialTheme.typography.bodyLarge) }
					if (running) {
						FilledTonalButton(onClick = onToggle, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
							Text(stringResource(R.string.end))
						}
					} else {
						Button(onClick = onToggle, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
							Text(stringResource(R.string.start))
						}
					}
					Text(
						stringResource(R.string.one_desktop_note),
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					session?.let { SessionDetails(it) }
				}
				BrandFooter()
			}
		}
	}

	@Composable
	private fun Section(title: String, highlighted: Boolean = false, content: @Composable () -> Unit) {
		val colors =
			if (highlighted) {
				CardDefaults.cardColors(
					containerColor = MaterialTheme.colorScheme.primaryContainer,
					contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
				)
			} else {
				CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)
			}
		Card(modifier = Modifier.fillMaxWidth(), colors = colors) {
			Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
				Text(title, style = MaterialTheme.typography.titleMedium)
				content()
			}
		}
	}

	@Composable
	private fun SessionDetails(session: Session) {
		SelectionContainer {
			Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Text(stringResource(R.string.address_label), style = MaterialTheme.typography.labelLarge)
				Text(session.addresses, fontFamily = FontFamily.Monospace)
				Text(
					stringResource(R.string.code_label),
					style = MaterialTheme.typography.labelLarge,
					modifier = Modifier.padding(top = 8.dp),
				)
				Text(session.pairingCode, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.headlineSmall)
				Text(
					stringResource(R.string.native_label),
					style = MaterialTheme.typography.labelLarge,
					modifier = Modifier.padding(top = 8.dp),
				)
				Text(session.nativeCommands, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
				Text(
					stringResource(R.string.unlock_note),
					style = MaterialTheme.typography.bodySmall,
					modifier = Modifier.padding(top = 8.dp),
				)
			}
		}
	}

	private companion object {
		const val PERMISSION_REQUEST = 1
		const val START_SCRIPT = "start.sh"
		const val STOP_SCRIPT = "stop.sh"
		const val NATIVE_WIFI_PREFIX = "native: "
		const val NATIVE_USB_PREFIX = "native usb: "
	}
}
