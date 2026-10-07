package app.neoconference.background_hold

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * A foreground service that only keeps the process running: a phone does
 * not freeze an app with one. Stops when told to, or by itself after
 * [LIMIT_MS] so a hold that is never released ends anyway.
 */
class HoldService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val giveUp = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty().ifEmpty { "Working…" }
        val notification = notification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
        } else {
            startForeground(ID, notification)
        }
        handler.removeCallbacks(giveUp)
        handler.postDelayed(giveUp, LIMIT_MS)
        return START_NOT_STICKY
    }

    // Android's own limit for a short service (3 min) — never reached
    // before ours, but it must not be ignored.
    override fun onTimeout(startId: Int) = stopSelf()

    override fun onTimeout(startId: Int, fgsType: Int) = stopSelf()

    override fun onDestroy() {
        handler.removeCallbacks(giveUp)
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val icon = resources.getIdentifier("ic_stat_call", "drawable", packageName)
            .takeIf { it != 0 } ?: applicationInfo.icon
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Background work", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Shown for a moment while the app finishes something you did from a notification."
                    setShowBadge(false)
                },
            )
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_MIN)
        }
        return builder.setSmallIcon(icon).setContentTitle(text).setOngoing(true).build()
    }

    companion object {
        const val EXTRA_TEXT = "text"
        private const val CHANNEL = "background"
        private const val ID = 0x484f4c44 // "HOLD"
        private const val LIMIT_MS = 30_000L
    }
}
