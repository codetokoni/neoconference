package app.neoconference

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the meeting alive while the app is not on screen.
 *
 * Android stops giving CPU to a backgrounded process within seconds, and a
 * process that is capturing a microphone without a foreground service of
 * the matching type is killed outright on Android 14. Neither is something
 * a Flutter widget can opt out of: the only thing that keeps audio flowing
 * when someone locks their phone or opens another app is a running
 * foreground service, and until now this app declared the permissions for
 * one and never started it.
 *
 * Written here rather than pulled in as a plugin. The service is forty
 * lines, the last plugin added to this project broke the Gradle build, and
 * the foregroundServiceType has to line up exactly with the manifest for
 * Android 14 to allow the start at all.
 */
class MeetingService : Service() {

    companion object {
        const val ACTION_START = "app.neoconference.MEETING_START"
        const val ACTION_STOP = "app.neoconference.MEETING_STOP"
        const val EXTRA_TITLE = "title"

        private const val CHANNEL_ID = "neo_meeting"
        private const val NOTIFICATION_ID = 4711

        fun start(context: Context, title: String) {
            val intent = Intent(context, MeetingService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
            }
            // startForegroundService is required from Android 8; the service
            // then has five seconds to call startForeground or be killed.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, MeetingService::class.java).apply { action = ACTION_STOP }
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelfSafely()
                return START_NOT_STICKY
            }
            else -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Meeting"
                startInForeground(title)
            }
        }
        // Not sticky: if Android kills the process the meeting is over, and
        // restarting this service without a LiveKit connection behind it
        // would show a notification for a call nobody is in.
        return START_NOT_STICKY
    }

    private fun startInForeground(title: String) {
        createChannel()

        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText("You are in a meeting")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(pending)
            // Not dismissable, and not a heads-up: it is a status, and a
            // notification that pops over the meeting would be absurd.
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()

        // Starting with the wrong type is fatal, not ignorable: Android
        // throws SecurityException out of startForeground and the whole
        // app goes down with it. That is exactly what the first version of
        // this did — it always asked for the microphone type, and a
        // meeting is joined muted, so RECORD_AUDIO had never been granted
        // and the process died on connect.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, serviceType())
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Nothing here is worth losing a meeting over. Give up on
            // keeping it alive in the background and let the call carry on
            // in the foreground, which is what happened before this
            // service existed at all.
            android.util.Log.w("MeetingService", "startForeground refused", e)
            stopSelfSafely()
        }
    }

    /**
     * The types this app is actually allowed to claim right now.
     *
     * Playback is the honest baseline: a muted participant is listening,
     * not capturing, and keeping that audio flowing is the whole point.
     * The microphone type is added only once RECORD_AUDIO has actually
     * been granted — Android checks the runtime grant, not the manifest
     * declaration, and refuses the start otherwise.
     */
    private fun serviceType(): Int {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (hasRecordAudio()) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        return type
    }

    private fun hasRecordAudio(): Boolean =
        ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Meetings",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shown while you are in a meeting."
            setShowBadge(false)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun stopSelfSafely() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        stopSelfSafely()
        super.onDestroy()
    }
}
