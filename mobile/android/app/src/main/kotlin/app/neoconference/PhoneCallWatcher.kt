package app.neoconference

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

/**
 * Tells the meeting when a phone call starts and ends.
 *
 * Nothing else does. flutter_webrtc registers an audio-focus listener with
 * an empty body, so when a cellular call takes the microphone the meeting
 * carries on sending silence and your tile still shows you unmuted.
 *
 * Reads the telephony call state, not the audio mode, and that choice was
 * measured rather than assumed. Driving a real call through the emulator:
 *
 *   ringing   call state 1   audio mode NORMAL
 *   answered  call state 2   audio mode RINGTONE
 *   hung up   call state 0   audio mode RINGTONE  <- stale
 *
 * The audio mode never flags a ringing call and is still claiming a call
 * after it has ended. Built on that, the meeting would have stayed paused
 * for a phone call forever. The call state goes 0 -> 1 -> 2 -> 0 cleanly.
 *
 * The cost is READ_PHONE_STATE, which Android 12+ requires for call-state
 * callbacks. Without it this does nothing at all — it never guesses from
 * the audio mode instead.
 */
class PhoneCallWatcher(
    private val context: Context,
    private val onChange: (inCall: Boolean) -> Unit,
) {
    // Lazy, because MainActivity holds this as a field: an Activity refuses
    // getSystemService until onCreate, and asking in the constructor
    // crashed the app on launch.
    private val telephony by lazy {
        context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
    }

    private var callback: Any? = null
    private var lastInCall: Boolean? = null

    val permitted: Boolean
        get() = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED

    /** Start listening. Safe to call again; a second call is a no-op. */
    fun start() {
        if (callback != null) return
        val tm = telephony ?: return
        if (!permitted) return

        // Registering can still throw on some builds even with the grant
        // (a SIM-less tablet, a managed profile). Nothing here is worth a
        // crash in the middle of a meeting, so a failure means no watching.
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) = report(state)
                }
                tm.registerTelephonyCallback(context.mainExecutor, cb)
                callback = cb
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Superseded by TelephonyCallback on API 31+")
                    override fun onCallStateChanged(state: Int, number: String?) =
                        report(state)
                }
                @Suppress("DEPRECATION")
                tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
                callback = listener
            }
        }.onFailure {
            android.util.Log.w("PhoneCallWatcher", "could not watch call state", it)
            callback = null
        }
    }

    /** Stop listening, and forget the last state so the next meeting starts clean. */
    fun stop() {
        val tm = telephony
        val cb = callback
        callback = null
        lastInCall = null
        if (tm == null || cb == null) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && cb is TelephonyCallback) {
                tm.unregisterTelephonyCallback(cb)
            } else if (cb is PhoneStateListener) {
                @Suppress("DEPRECATION")
                tm.listen(cb, PhoneStateListener.LISTEN_NONE)
            }
        }
    }

    private fun report(state: Int) {
        // Ringing counts as a call. By the time it is answered the person
        // has already stopped listening to the meeting, and muting then
        // would be too late to stop the ringtone going out.
        val inCall = state == TelephonyManager.CALL_STATE_RINGING ||
            state == TelephonyManager.CALL_STATE_OFFHOOK
        // Registration delivers the current state immediately. Report only
        // changes, so joining a meeting while idle says nothing at all.
        if (inCall == lastInCall) return
        val first = lastInCall == null
        lastInCall = inCall
        if (first && !inCall) return
        onChange(inCall)
    }
}
