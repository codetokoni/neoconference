package app.neoconference

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import io.flutter.plugin.common.MethodChannel
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Reads translated captions aloud on the meeting's own audio path.
 *
 * Text-to-speech normally plays as media, at the media volume — and in a
 * meeting people turn up the call volume, not the media one. On the
 * owner's phone media was at 0 on the speaker and earpiece while the call
 * was at 15, so the translation "worked" (the text showed) and was never
 * heard. Speaking with USAGE_VOICE_COMMUNICATION puts it on the call's
 * stream: the call's volume, and the call's route (earpiece, speaker,
 * headset or Bluetooth), the same as the people it translates.
 *
 * The flutter_tts plugin cannot choose that usage, hence this.
 */
class MeetingVoice(context: Context) {

    private val pending = ConcurrentHashMap<String, MethodChannel.Result>()
    private var ready = false
    private var failed = false
    private val waiting = mutableListOf<() -> Unit>()
    private var counter = 0

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        failed = !ready
        val queued = waiting.toList()
        waiting.clear()
        queued.forEach { it() }
    }

    init {
        tts.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {}
            override fun onDone(utteranceId: String) {
                pending.remove(utteranceId)?.success(mapOf("status" to "done"))
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) {
                pending.remove(utteranceId)?.success(mapOf("status" to "error", "message" to "speech engine error"))
            }
            override fun onError(utteranceId: String, errorCode: Int) {
                pending.remove(utteranceId)?.success(mapOf("status" to "error", "message" to "speech engine error $errorCode"))
            }
            override fun onStop(utteranceId: String, interrupted: Boolean) {
                pending.remove(utteranceId)?.success(mapOf("status" to "stopped"))
            }
        })
    }

    /** Speaks [text] in [languageTag] (e.g. "es-ES"); answers when it has been said. */
    fun speak(text: String, languageTag: String, result: MethodChannel.Result) {
        val go = {
            if (failed) {
                result.success(mapOf("status" to "error", "message" to "no speech engine"))
            } else {
                val availability = tts.setLanguage(Locale.forLanguageTag(languageTag))
                if (availability == TextToSpeech.LANG_MISSING_DATA || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
                    result.success(mapOf("status" to "error", "message" to "language $languageTag not installed"))
                } else {
                    tts.setSpeechRate(1.0f)
                    val id = "neo-${counter++}"
                    pending[id] = result
                    val queued = tts.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id)
                    if (queued != TextToSpeech.SUCCESS) {
                        pending.remove(id)?.success(mapOf("status" to "error", "message" to "speak refused"))
                    }
                }
            }
        }
        if (ready || failed) go() else waiting.add(go)
    }

    /**
     * Whether this phone has a voice for [languageTag]. Google's engine has
     * none for Igbo, Hausa or Yoruba, nor any to download; asked before
     * speaking so the meeting can say so instead of going quiet.
     */
    fun canSpeak(languageTag: String, result: MethodChannel.Result) {
        val go = {
            if (failed) {
                result.success(false)
            } else {
                val availability = tts.isLanguageAvailable(Locale.forLanguageTag(languageTag))
                result.success(availability >= TextToSpeech.LANG_AVAILABLE)
            }
        }
        if (ready || failed) go() else waiting.add(go)
    }

    fun stop() {
        tts.stop()
        val left = pending.keys.toList()
        left.forEach { pending.remove(it)?.success(mapOf("status" to "stopped")) }
    }

    fun shutdown() {
        stop()
        tts.shutdown()
    }
}
