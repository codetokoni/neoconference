package app.neoconference

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import io.flutter.plugin.common.MethodChannel

/**
 * KingsChat login, the way KingsChat's mobile docs describe it
 * (developers.kingschat.online/docs/mobile): the installed KingsChat app
 * is asked to authorise us and hands back a one-time authorization code,
 * which the server exchanges for tokens.
 *
 * This is the KingsLogin-android SDK's handshake done in place rather than
 * through the library: its only release (v0.0.1, 2019) is built on the old
 * support libraries and Kotlin synthetics, and the handshake itself is a
 * dozen lines — the same intent action, extras and result codes as its
 * KingsLogin.requestPermissions and KingsLoginManager.onActivityResult. The
 * client id is read from the same manifest meta-data the SDK reads.
 *
 * KingsChat checks the caller's package and signing certificate against
 * those registered for the client id, which is why only a build signed
 * with the release key can complete it.
 */
class KingsChatLogin {

    private var pending: MethodChannel.Result? = null

    companion object {
        const val REQUEST = 8842
        const val KC_PACKAGE = "com.joinkingschat.android"
        private const val CLIENT_ID_KEY = "com.kingschat.sdk.ApplicationId"
    }

    fun authorize(activity: Activity, scopes: List<String>, result: MethodChannel.Result) {
        if (pending != null) {
            result.success(mapOf("status" to "error", "message" to "A KingsChat sign-in is already open."))
            return
        }
        val clientId = try {
            @Suppress("DEPRECATION")
            activity.packageManager
                .getApplicationInfo(activity.packageName, PackageManager.GET_META_DATA)
                .metaData?.getString(CLIENT_ID_KEY)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        }
        if (clientId.isNullOrBlank()) {
            result.success(mapOf("status" to "error", "message" to "KingsChat client id missing from the manifest."))
            return
        }

        val installed = try {
            activity.packageManager.getPackageInfo(KC_PACKAGE, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
        if (!installed) {
            result.success(mapOf("status" to "not_installed"))
            return
        }

        val intent = Intent("$KC_PACKAGE.AUTHORIZE_APP")
            .addCategory(Intent.CATEGORY_DEFAULT)
            .putStringArrayListExtra("scopes", ArrayList(scopes))
            .putExtra("clientId", clientId)
        if (activity.packageManager.queryIntentActivities(intent, 0).isEmpty()) {
            // An old KingsChat that cannot sign apps in.
            result.success(mapOf("status" to "not_supported"))
            return
        }

        pending = result
        @Suppress("DEPRECATION")
        activity.startActivityForResult(intent, REQUEST)
    }

    /** True when the result was ours. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST) return false
        val result = pending ?: return true
        pending = null
        when (resultCode) {
            Activity.RESULT_OK -> {
                val code = data?.getStringExtra("code")
                if (code.isNullOrBlank()) {
                    result.success(mapOf("status" to "error", "message" to "KingsChat returned no code."))
                } else {
                    result.success(
                        mapOf(
                            "status" to "ok",
                            "code" to code,
                            "acceptedScopes" to (data.getStringArrayListExtra("accepted_scopes") ?: arrayListOf<String>()),
                            "rejectedScopes" to (data.getStringArrayListExtra("rejected_scopes") ?: arrayListOf<String>()),
                        )
                    )
                }
            }
            Activity.RESULT_CANCELED -> result.success(mapOf("status" to "cancelled"))
            else -> result.success(
                mapOf(
                    "status" to "error",
                    "message" to (data?.getStringExtra("error_message") ?: "No response from KingsChat."),
                )
            )
        }
        return true
    }
}
