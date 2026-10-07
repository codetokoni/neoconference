package app.neoconference.background_hold

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** "app.neoconference/hold": start and stop [HoldService]. */
class BackgroundHoldPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "app.neoconference/hold").also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = context ?: return result.success(false)
        when (call.method) {
            "start" -> {
                val intent = Intent(ctx, HoldService::class.java)
                    .putExtra(HoldService.EXTRA_TEXT, call.argument<String>("text") ?: "")
                try {
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
                    result.success(true)
                } catch (e: Exception) {
                    // Android 12+ refuses a foreground service from the
                    // background unless the person just acted on the app.
                    Log.w("BackgroundHold", "start: $e")
                    result.success(false)
                }
            }
            "stop" -> {
                ctx.stopService(Intent(ctx, HoldService::class.java))
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }
}
