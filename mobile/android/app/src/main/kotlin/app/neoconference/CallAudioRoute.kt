package app.neoconference

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Where Android is sending the call's audio, and the one thing that can put
 * it back on a Bluetooth headset.
 *
 * Found on a phone with earbuds: the meeting moved onto the earbuds'
 * headset link when they connected, then another calling app (KingsChat)
 * claimed call audio and the earbuds closed that link. Android fell back
 * to the earbuds' media link — sound in the ears, microphone on the phone
 * — and nothing in the app noticed: it re-applies the route only when the
 * device list changes, and here nothing had connected or disconnected.
 * "Headset or earpiece" did not bring it back either; it only flips the
 * speaker preference.
 *
 * This reports every change of the communication device, names the
 * headset that could carry the call, and asks for it directly with
 * setCommunicationDevice. Android 12 and later only: that is where the
 * API exists. Earlier versions get no reports and no headset, rather than
 * a guess.
 */
class CallAudioRoute(
    private val context: Context,
    private val onChange: (route: String?, headset: String?) -> Unit,
) {
    private val audio: AudioManager by lazy {
        context.getSystemService(AudioManager::class.java)
    }

    // Typed as Any so the class loads on versions without the interface.
    private var listener: Any? = null

    val supported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    fun start() {
        if (!supported || listener != null) return
        val l = AudioManager.OnCommunicationDeviceChangedListener { device ->
            onChange(kind(device), headsetName())
        }
        audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, l)
        listener = l
    }

    fun stop() {
        if (!supported) return
        (listener as? AudioManager.OnCommunicationDeviceChangedListener)?.let {
            audio.removeOnCommunicationDeviceChangedListener(it)
        }
        listener = null
    }

    /** The current route: bluetooth, bluetooth_media, speaker, earpiece, wired, other, or null. */
    fun route(): String? = if (supported) kind(audio.communicationDevice) else null

    /** The name of a Bluetooth headset that could carry the call, if one is connected. */
    fun headsetName(): String? {
        val device = headset() ?: return null
        return device.productName?.toString()?.takeIf { it.isNotBlank() } ?: "Bluetooth headset"
    }

    /** Put the call on the Bluetooth headset. False when there is none or Android refused. */
    fun useHeadset(): Boolean {
        if (!supported) return false
        val device = headset() ?: return false
        return try {
            audio.setCommunicationDevice(device)
        } catch (e: IllegalArgumentException) {
            false
        }
    }

    private fun headset(): AudioDeviceInfo? {
        if (!supported) return null
        return audio.availableCommunicationDevices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
    }

    private fun kind(device: AudioDeviceInfo?): String? = when (device?.type) {
        null -> null
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
        // Sound only: the microphone stays on the phone.
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_media"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        else -> "other"
    }
}
