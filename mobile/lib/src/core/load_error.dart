import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_client.dart';

/// What to tell a person when a list could not be loaded.
///
/// The screens used to print the exception itself. On a real phone that
/// was four lines of "ClientException with SocketException: Connection
/// reset by peer (OS Error...)" ending in the session's ID — nothing anyone
/// could act on, and not something to put on a screen. The raw error still
/// goes to the log, where it is useful.
String describeLoadError(Object error) {
  debugPrint('[load] $error');
  if (error is SocketException ||
      error is http.ClientException ||
      error is TimeoutException ||
      error is HandshakeException) {
    return "Couldn't reach NeoConference. Check your connection and try "
        'again.';
  }
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
