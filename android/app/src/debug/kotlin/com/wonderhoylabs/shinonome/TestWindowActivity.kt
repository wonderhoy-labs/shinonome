package com.wonderhoylabs.shinonome

import android.app.Activity
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.sin

/**
 * A harmless target for tools/measure.ts: pressing it changes its color and it has a box to type
 * in, so input can be tested without touching anyone's real apps. Not shown in the launcher.
 * Started with --ez tone true, it also beeps twice a second, to test sound.
 */
class TestWindowActivity : Activity() {

	private var primaryColor = 0

	@Volatile
	private var beeping = false

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val pressTarget = View(this)
		pressTarget.setBackgroundColor(COLORS[primaryColor])
		pressTarget.setOnTouchListener { touched, event ->
			if (event.actionMasked == MotionEvent.ACTION_DOWN) {
				if (event.buttonState and MotionEvent.BUTTON_SECONDARY != 0) {
					touched.setBackgroundColor(SECONDARY_BUTTON_COLOR)
				} else {
					primaryColor = (primaryColor + 1) % COLORS.size
					touched.setBackgroundColor(COLORS[primaryColor])
				}
			}
			true
		}
		val root = LinearLayout(this)
		root.orientation = LinearLayout.VERTICAL
		root.addView(EditText(this), LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
		root.addView(pressTarget, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
		setContentView(root)
		if (intent.getBooleanExtra("tone", false)) {
			beeping = true
			thread(name = "tone") { beep() }
		}
	}

	override fun onDestroy() {
		beeping = false
		super.onDestroy()
	}

	/** 100 ms of A4, then 400 ms of quiet, until the window closes. */
	private fun beep() {
		val rate = 48_000
		val period = ShortArray(rate / 2)
		for (i in 0 until rate / 10) {
			period[i] = (sin(2 * PI * 440 * i / rate) * Short.MAX_VALUE / 4).toInt().toShort()
		}
		val track = AudioTrack.Builder()
			.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build())
			.setAudioFormat(
				AudioFormat.Builder()
					.setEncoding(AudioFormat.ENCODING_PCM_16BIT)
					.setSampleRate(rate)
					.setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
					.build(),
			)
			.setBufferSizeInBytes(period.size * 2)
			.build()
		track.play()
		while (beeping) {
			track.write(period, 0, period.size)
		}
		track.stop()
		track.release()
	}

	private companion object {
		val COLORS = intArrayOf(Color.rgb(30, 60, 120), Color.rgb(230, 230, 240))
		val SECONDARY_BUTTON_COLOR = Color.rgb(230, 120, 30)
	}
}
