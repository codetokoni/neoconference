import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../auth/clerk_client.dart' show ClerkException;
import 'api_client.dart';

const _unreachable =
    "Couldn't reach NeoLinguaMeet. Check your connection and try again.";

const _lookupFailed =
    "Your network couldn't find NeoLinguaMeet's servers. Try mobile data or "
    "another Wi-Fi. If that works, your Wi-Fi's DNS is the problem.";

/// The request never got an answer: no network, no DNS, a dropped
/// connection. Its text is the worst to show — a failed session-token
/// fetch prints Clerk's URL with the session's ID in it.
bool isNetworkError(Object error) =>
    error is SocketException ||
    error is http.ClientException ||
    error is TimeoutException ||
    error is HandshakeException;

/// The network could not turn our address into a server: DNS. Seen on
/// 2026-11-21 on a Wi-Fi whose router timed out or answered SERVFAIL for
/// the LiveKit host and neoconference.app while public resolvers found
/// them, and other apps worked. "Check your connection" sent people
/// looking for the wrong cause; this one points at the way through.
///
/// Dart says it as "Failed host lookup" (errno 7 on Android). The http
/// package wraps it in a ClientException whose message carries the
/// SocketException's text, which is also how LiveKit's /rtc/validate
/// failure reaches the join screen.
bool isLookupFailure(Object error) {
  const marker = 'Failed host lookup';
  if (error is SocketException) return error.message.contains(marker);
  if (error is http.ClientException) return error.message.contains(marker);
  return false;
}

String _networkText(Object error) =>
    isLookupFailure(error) ? _lookupFailed : _unreachable;

/// What to tell a person when something they did failed.
///
/// Unlike [describeLoadError], an error that is not a network failure keeps
/// its own words: a LiveKit or plugin error is usually more use to the
/// person (and to whoever they send a screenshot to) than "something went
/// wrong". A server refusal gives the server's own message.
String describeActionError(Object error) {
  debugPrint('[action] $error');
  if (isNetworkError(error)) return _networkText(error);
  // A 401 that survived a retry with a fresh token (ApiClient): the
  // session really has ended. The bare "Unauthorized" said nothing to do.
  if (error is ApiException && error.isUnauthenticated) {
    return 'Your sign-in has expired. Sign out and sign in again.';
  }
  if (error is ApiException) return error.message;
  // Clerk itself busy or down, which is not the same as signed out.
  if (error is ClerkException && !error.sessionGone) {
    return "Couldn't reach the sign-in service. Check your connection and try again.";
  }
  return '$error';
}

/// What to tell a person when a list could not be loaded.
///
/// The screens used to print the exception itself. On a real phone that
/// was four lines of "ClientException with SocketException: Connection
/// reset by peer (OS Error...)" ending in the session's ID — nothing anyone
/// could act on, and not something to put on a screen. The raw error still
/// goes to the log, where it is useful.
String describeLoadError(Object error) {
  debugPrint('[load] $error');
  if (isNetworkError(error)) return _networkText(error);
  if (error is ApiException) {
    if (error.isUnauthenticated) {
      return 'Your session has ended. Please sign in again.';
    }
    if (error.status >= 500) {
      return 'NeoLinguaMeet is having trouble right now. Try again in a '
          'moment.';
    }
  }
  return 'Something went wrong. Try again.';
}
