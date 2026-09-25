package app.neoconference

import android.Manifest
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Rational
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The Android side of "the meeting keeps going when the app does not".
 *
 * Two things Flutter cannot do on its own:
 *
 *  - Start a foreground service, which is the only thing that keeps audio
 *    flowing once the app is backgrounded or the screen is locked.
 *  - Enter Picture in Picture, which is an Activity-level call and needs
 *    the Activity to report back when the mode changes so the UI can shrink
 *    to something that reads at 150dp wide.
 */
class MainActivity : FlutterActivity() {

    private var channel: MethodChannel? = null

    /**
     * Whether a meeting is on screen right now.
     *
     * Set by Flutter. PiP is only entered while this is true — pressing
     * Home from the meetings list should close the app, not float a window
     * of a list.
     */
    private var inMeeting = false

    private val phoneCalls = PhoneCallWatcher(this) { inCall ->
        channel?.invokeMethod("phoneCall", inCall)
    }

    // Callbacks arrive on a ConnectivityManager thread; the channel wants
    // the main one.
    private val network = NetworkWatcher(this) {
        runOnUiThread { channel?.invokeMethod("networkAvailable", null) }
    }

    private companion object {
        const val BLUETOOTH_REQUEST = 8801
        const val PHONE_REQUEST = 8802
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val methods = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "app.neoconference/meeting"
        )
        channel = methods
        network.start()

        methods.setMethodCallHandler { call, result ->
            when (call.method) {
                "startMeeting" -> {
                    inMeeting = true
                    val title = call.argument<String>("title") ?: "Meeting"
                    MeetingService.start(this, title)
                    phoneCalls.start()
                    updateAutoPip()
                    result.success(true)
                }

                "stopMeeting" -> {
                    inMeeting = false
                    MeetingService.stop(this)
                    phoneCalls.stop()
                    updateAutoPip()
                    result.success(true)
                }

                "ensurePhoneState" -> result.success(ensurePhoneState())

                "enterPip" -> result.success(enterPip())

                "pipSupported" -> result.success(pipSupported())

                "ensureBluetooth" -> result.success(ensureBluetooth())

                else -> result.notImplemented()
            }
        }
    }

    /**
     * Ask for BLUETOOTH_CONNECT, which is what actually routes call audio
     * to a headset.
     *
     * The manifest has declared it since the app shipped and nothing ever
     * requested it, so the grant was never given: with earbuds connected
     * and "Headset" chosen, Android reported
     * "Active communication device: type:earpiece" and the audio came out
     * of the phone. A2DP still played media through the earbuds, which is
     * why this looked like it worked until someone checked.
     *
     * Returns whether the permission is already held. The dialog's answer
     * arrives asynchronously and is not waited for — routing takes effect
     * on the next switch, and blocking a meeting on a permission dialog
     * would be worse than routing to the earpiece once.
     */
    private fun ensureBluetooth(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return true
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT),
            BLUETOOTH_REQUEST
        )
        return false
    }

    /**
     * Ask for READ_PHONE_STATE, which is what lets the meeting notice a
     * phone call.
     *
     * Asked at the same moment as Bluetooth and for the same reason: this
     * is where it is needed. The answer is not waited on — a meeting never
     * blocks on a permission prompt. If it is granted after the meeting
     * started, onRequestPermissionsResult starts watching then.
     */
    private fun ensurePhoneState(): Boolean {
        if (phoneCalls.permitted) return true
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.READ_PHONE_STATE),
            PHONE_REQUEST
        )
        return false
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PHONE_REQUEST &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED &&
            inMeeting
        ) {
            phoneCalls.start()
        }
    }

    override fun onDestroy() {
        phoneCalls.stop()
        network.stop()
        super.onDestroy()
    }

    private fun pipSupported(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        val builder = PictureInPictureParams.Builder()
            // 16:9 because that is the shape of the video inside it.
            // Android clamps anything more extreme than roughly 2.39:1.
            .setAspectRatio(Rational(16, 9))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Seamless on Android 12 and up: the window shrinks as the
            // gesture happens rather than after it, so there is no frame
            // where the meeting has visibly disappeared.
            builder.setAutoEnterEnabled(inMeeting)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    private fun updateAutoPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        if (!pipSupported()) return
        runCatching { pipParams()?.let { setPictureInPictureParams(it) } }
    }

    private fun enterPip(): Boolean {
        if (!pipSupported()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        return runCatching {
            pipParams()?.let { enterPictureInPictureMode(it) } ?: false
        }.getOrDefault(false)
    }

    /**
     * Pressing Home or swiping up during a meeting floats it instead of
     * hiding it.
     *
     * Only needed below Android 12; above it setAutoEnterEnabled has
     * already handled the gesture by the time this runs.
     */
    @Deprecated("Required below API 31, where auto-enter does not exist")
    override fun onUserLeaveHint() {
        if (inMeeting && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            enterPip()
        }
        @Suppress("DEPRECATION")
        super.onUserLeaveHint()
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        // Flutter keeps rendering the whole meeting screen into a window a
        // few centimetres wide unless it is told to draw something else.
        channel?.invokeMethod("pipChanged", isInPictureInPictureMode)
    }
}
