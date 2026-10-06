package app.neoconference

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Rings like a phone call while a group meeting is calling someone: the
 * phone's own ringtone, and vibration, as the ringer switch allows —
 * silent rings not at all, vibrate only vibrates.
 *
 * The app's incoming-call screen starts and stops it; the ring itself
 * lasts as long as the server's (45 s) at most.
 */
class IncomingRinger(private val context: Context) {

    private var ringtone: Ringtone? = null
    private var vibrating = false

    fun start() {
        stop()
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val mode = audio.ringerMode
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(context, uri)?.apply {
                audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
                play()
            }
        }
        if (mode != AudioManager.RINGER_MODE_SILENT) {
            vibrator()?.let {
                // On 1 s, off 1 s, over and over.
                it.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 1000, 1000), 0))
                vibrating = true
            }
        }
    }

    fun stop() {
        ringtone?.stop()
        ringtone = null
        if (vibrating) {
            vibrator()?.cancel()
            vibrating = false
        }
    }

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
}
