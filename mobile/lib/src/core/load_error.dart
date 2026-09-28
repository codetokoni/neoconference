import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_client.dart';

const _unreachable =
    "Couldn't reach NeoConference. Check your connection and try again.";

/// The request never got an answer: no network, no DNS, a dropped
/// connection. Its text is the worst to show — a failed session-token
/// fetch prints Clerk's URL with the session's ID in it.
bool isNetworkError(Object error) =>
    error is SocketException ||
    error is http.ClientException ||
    error is TimeoutException ||
    error is HandshakeException;

/// What to tell a person when something they did failed.
///
/// Unlike [describeLoadError], an error that is not a network failure keeps
/// its own words: a LiveKit or plugin error is usually more use to the
/// person (and to whoever they send a screenshot to) than "something went
/// wrong". A server refusal gives the server's own message.
String describeActionError(Object error) {
  debugPrint('[action] $error');
  if (isNetworkError(error)) return _unreachable;
  if (error is ApiException) return error.message;
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
  if (isNetworkError(error)) return _unreachable;
  if (error is ApiException) {
    if (error.isUnauthenticated) {
      return 'Your session has ended. Please sign in again.';
    }
    if (error.status >= 500) {
      return 'NeoConference is having trouble right now. Try again in a '
          'moment.';
    }
  }
  return 'Something went wrong. Try again.';
}
