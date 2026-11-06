package com.wonderhoylabs.shinonome

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout

/**
 * A harmless target for tools/measure.mjs: pressing it changes its color and it has a box to type
 * in, so input can be tested without touching anyone's real apps. Not shown in the launcher.
 */
class TestWindowActivity : Activity() {

    private var primaryColor = 0

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
    }

    private companion object {
        val COLORS = intArrayOf(Color.rgb(30, 60, 120), Color.rgb(230, 230, 240))
        val SECONDARY_BUTTON_COLOR = Color.rgb(230, 120, 30)
    }
}
