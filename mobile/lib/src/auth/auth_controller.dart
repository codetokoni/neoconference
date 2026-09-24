import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/config.dart';
import 'clerk_client.dart';

@immutable
class AuthState {
  const AuthState({
    this.sessionId,
    this.displayName,
    this.busy = false,
    this.error,
    this.restoring = true,
    this.upgradedTo,
  });

  final String? sessionId;
  final String? displayName;
  final bool busy;
  final String? error;

  /// True until the stored session has been checked, so the app can hold the
  /// splash instead of flashing the sign-in screen at someone already signed
  /// in.
  final bool restoring;

  /// The plan a payment just granted, when one came back on the deep link.
  /// Cleared once shown; the app does not track plans itself.
  final String? upgradedTo;

  bool get signedIn => sessionId != null;

  AuthState copyWith({
    String? sessionId,
    String? displayName,
    bool? busy,
    String? error,
    bool? restoring,
    String? upgradedTo,
    bool clearError = false,
    bool clearSession = false,
    bool clearUpgraded = false,
  }) =>
      AuthState(
        sessionId: clearSession ? null : (sessionId ?? this.sessionId),
        displayName: clearSession ? null : (displayName ?? this.displayName),
        busy: busy ?? this.busy,
        error: clearError ? null : (error ?? this.error),
        restoring: restoring ?? this.restoring,
        upgradedTo: clearUpgraded ? null : (upgradedTo ?? this.upgradedTo),
      );
}

/// Sign-in, sign-out, and handing a fresh token to every API call.
///
/// Three ways in, all ending at the same place — a Clerk session:
///
///   * Email and password, straight to Clerk.
///   * KingsChat and NeoEmail, by opening the website's existing OAuth
///     routes in the phone's browser. Those already finish by minting a
///     Clerk sign-in ticket, so the app hands the ticket back to Clerk
///     rather than reimplementing either provider.
class AuthController extends StateNotifier<AuthState> {
  AuthController(this._clerk) : super(const AuthState()) {
    _restore();
    _listenForCallback();
  }

  final ClerkClient _clerk;
  final _links = AppLinks();
  StreamSubscription<Uri>? _linkSub;

  static const _sessionKey = 'neo.clerk.session';
  static const _cookieKey = 'neo.clerk.client';

  Future<void> _restore() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _clerk.clientCookie = prefs.getString(_cookieKey);
      final sessionId = prefs.getString(_sessionKey);
      if (sessionId == null) {
        state = state.copyWith(restoring: false);
        return;
      }
      // Ask Clerk whether the stored session is still real. A session the
      // person ended elsewhere must not leave the app looking signed in.
      //
      // "Clerk says this session is dead" and "I could not reach Clerk" are
      // answered differently on purpose. Treating them the same signed
      // people out — and deleted the stored session, so it could not come
      // back — every time the phone had a bad moment, which on a patchy
      // connection is often. Only an explicit refusal forgets anything.
      String? token;
      try {
        token = await _clerk.sessionToken(sessionId);
      } catch (_) {
        state = state.copyWith(
          sessionId: sessionId,
          displayName: prefs.getString('neo.clerk.name'),
          restoring: false,
        );
        return;
      }
      if (token == null) {
        await _forget();
        state = state.copyWith(restoring: false);
        return;
      }
      state = state.copyWith(
        sessionId: sessionId,
        displayName: prefs.getString('neo.clerk.name'),
        restoring: false,
      );
    } catch (_) {
      // Storage that will not answer must not strand the app on a splash
      // screen; treat it as signed out.
      state = state.copyWith(restoring: false);
    }
  }

  void _listenForCallback() {
    _linkSub = _links.uriLinkStream.listen((uri) {
      final ticket = uri.queryParameters['__clerk_ticket'];
      if (ticket != null && ticket.isNotEmpty) {
        unawaited(_completeWithTicket(ticket));
        return;
      }
      // A finished plan purchase comes back on the same link. Nothing to
      // redeem — the server has already promoted the account — but the
      // plan the app is holding is now stale, so anything gated on it has
      // to be asked for again rather than trusted.
      final upgraded = uri.queryParameters['upgraded'];
      if (upgraded != null && upgraded.isNotEmpty) {
        state = state.copyWith(
          busy: false,
          clearError: true,
          upgradedTo: upgraded,
        );
        return;
      }

      // A cancelled or failed payment returns here too. Saying so matters:
      // the person left the app, went through a checkout, and came back —
      // silently reappearing on the same screen reads like the app lost
      // their attempt rather than the payment simply not happening.
      final payment = uri.queryParameters['payment'];
      if (payment != null && payment.isNotEmpty) {
        state = state.copyWith(
          busy: false,
          error: payment == 'cancelled'
              ? 'Payment was not completed. Your plan is unchanged.'
              : 'The payment did not go through. Your plan is unchanged.',
        );
        return;
      }

      // The website reports a failed KingsChat or NeoEmail sign-in by
      // redirecting with an error parameter rather than a ticket.
      final failed = uri.queryParameters['kc_error'] ?? uri.queryParameters['ne_error'];
      if (failed != null) {
        state = state.copyWith(
          busy: false,
          error: 'Sign-in did not complete. Please try again.',
        );
      }
    });
  }

  Future<void> signInWithPassword(String email, String password) async {
    state = state.copyWith(busy: true, clearError: true);
    try {
      final sessionId = await _clerk.signInWithPassword(
        email: email,
        password: password,
      );
      await _remember(sessionId);
    } on ClerkException catch (e) {
      state = state.copyWith(busy: false, error: e.message);
    } catch (_) {
      state = state.copyWith(
        busy: false,
        error: 'Could not reach the sign-in service. Check your connection.',
      );
    }
  }

  /// Opens KingsChat or NeoEmail in the phone's browser.
  ///
  /// [provider] is 'kingschat' or 'neoemail'. The website's start route takes
  /// a redirect_url, and its callback preserves that across the round trip,
  /// so pointing it at the app's deep link is all that's needed to get the
  /// ticket back here.
  Future<void> signInWithProvider(String provider) async {
    state = state.copyWith(busy: true, clearError: true);
    final url = Uri.parse('${Config.site}/api/auth/$provider/start').replace(
      queryParameters: {'redirect_url': Config.deepLinkCallback},
    );
    final opened = await launchUrl(url, mode: LaunchMode.externalApplication);
    if (!opened) {
      state = state.copyWith(
        busy: false,
        error: 'Could not open the browser to sign in.',
      );
    }
    // Otherwise the deep-link listener takes it from here.
  }

  Future<void> _completeWithTicket(String ticket) async {
    state = state.copyWith(busy: true, clearError: true);
    try {
      final sessionId = await _clerk.signInWithTicket(ticket);
      await _remember(sessionId);
    } on ClerkException catch (e) {
      state = state.copyWith(busy: false, error: e.message);
    }
  }

  Future<void> _remember(String sessionId) async {
    String? name;
    try {
      final me = await _clerk.me();
      final first = me?['first_name'] as String?;
      final username = me?['username'] as String?;
      name = (first?.trim().isNotEmpty ?? false) ? first : username;
    } catch (_) {
      // A missing display name is cosmetic.
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_sessionKey, sessionId);
      if (_clerk.clientCookie != null) {
        await prefs.setString(_cookieKey, _clerk.clientCookie!);
      }
      if (name != null) await prefs.setString('neo.clerk.name', name);
    } catch (_) {
      // Signed in for this run even if the phone refuses to remember it.
    }
    state = state.copyWith(
      sessionId: sessionId,
      displayName: name,
      busy: false,
      restoring: false,
      clearError: true,
    );
  }

  /// Drops the just-upgraded marker once it has been shown, so the
  /// confirmation does not reappear on the next rebuild.
  void acknowledgeUpgrade() => state = state.copyWith(clearUpgraded: true);

  /// Drops a message once shown, so it does not reappear on every rebuild.
  void clearError() => state = state.copyWith(clearError: true);

  Future<void> signOut() async {
    final sessionId = state.sessionId;
    state = state.copyWith(clearSession: true, clearError: true);
    await _forget();
    if (sessionId != null) await _clerk.signOut(sessionId);
  }

  Future<void> _forget() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_sessionKey);
      await prefs.remove('neo.clerk.name');
    } catch (_) {
      // Nothing useful to do if storage refuses.
    }
  }

  /// A fresh session JWT for the API client, or null when signed out.
  Future<String?> currentToken() async {
    final sessionId = state.sessionId;
    if (sessionId == null) return null;
    return _clerk.sessionToken(sessionId);
  }

  @override
  void dispose() {
    _linkSub?.cancel();
    super.dispose();
  }
}

final clerkClientProvider = Provider<ClerkClient>((ref) {
  final client = ClerkClient();
  ref.onDispose(client.close);
  return client;
});

final authProvider = StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(ref.watch(clerkClientProvider));
});
