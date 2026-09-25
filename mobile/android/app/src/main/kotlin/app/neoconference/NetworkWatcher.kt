package app.neoconference

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/**
 * Says when the device has a working network again.
 *
 * "Working" is Android's validated capability — it has reached the
 * internet, not just associated with a Wi-Fi access point that goes
 * nowhere. Reporting on association alone would send a rejoin into a
 * captive portal or a network still coming up, and it would fail.
 *
 * Reports only the transition from not validated to validated, once per
 * return. What happens with it is Flutter's call: a meeting that dropped
 * uses it to rejoin at once instead of at its next retry.
 */
class NetworkWatcher(
    context: Context,
    private val onReturn: () -> Unit,
) {
    // Lazy for the same reason as PhoneCallWatcher's: MainActivity holds
    // this as a field, and an Activity refuses system services until
    // onCreate. Asking in the constructor crashed the app on launch once.
    private val connectivity by lazy {
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    }

    private var validated = false
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start() {
        val cm = connectivity ?: return
        if (callback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val now = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val returned = now && !validated
                validated = now
                if (returned) onReturn()
            }

            override fun onLost(network: Network) {
                validated = false
            }
        }
        runCatching {
            cm.registerDefaultNetworkCallback(cb)
            callback = cb
        }.onFailure {
            android.util.Log.w("NetworkWatcher", "could not watch the network", it)
        }
    }

    fun stop() {
        val cm = connectivity ?: return
        val cb = callback ?: return
        callback = null
        runCatching { cm.unregisterNetworkCallback(cb) }
    }
}
