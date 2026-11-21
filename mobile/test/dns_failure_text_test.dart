import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:neoconference/src/core/load_error.dart';

/// Owner's phone, 2026-11-21, on a Wi-Fi whose router could not resolve
/// the LiveKit host or neoconference.app (8.8.8.8 could). The join screen
/// said "Couldn't reach NeoLinguaMeet. Check your connection" while every
/// other app worked, which sent people looking for the wrong cause. A
/// lookup failure now says it is the network's DNS and how to get past it.
void main() {
  const lookupText =
      "Your network couldn't find NeoLinguaMeet's servers. Try mobile data "
      "or another Wi-Fi. If that works, your Wi-Fi's DNS is the problem.";
  const unreachableText =
      "Couldn't reach NeoLinguaMeet. Check your connection and try again.";

  // As logcat had it: errno 7 is Android's "no address associated".
  const lookup = SocketException(
    "Failed host lookup: 'neoconference-dev-01ptt1d1.livekit.cloud' "
    '(OS Error: No address associated with hostname, errno = 7)',
    osError: OSError('No address associated with hostname', 7),
  );

  // What LiveKit's /rtc/validate GET throws: the http package wraps the
  // SocketException, keeping its text in the message.
  final wrappedLookup = http.ClientException(
    "SocketException: Failed host lookup: 'neoconference-dev-01ptt1d1.livekit.cloud' "
    '(OS Error: No address associated with hostname, errno = 7)',
    Uri.parse('https://neoconference-dev-01ptt1d1.livekit.cloud/rtc/validate'),
  );

  final reset = http.ClientException(
    'SocketException: Connection reset by peer (OS Error: Connection reset '
    'by peer, errno = 104), address = clerk.neoconference.app, port = 53114',
    Uri.parse('https://clerk.neoconference.app/v1/client/sessions/sess_x/tokens'),
  );

  final timeout = TimeoutException('No answer', const Duration(seconds: 10));

  for (final (name, describe) in [
    ('describeActionError', describeActionError),
    ('describeLoadError', describeLoadError),
  ]) {
    group(name, () {
      test('a failed lookup names DNS and offers another network', () {
        expect(describe(lookup), lookupText);
      });

      test('a failed lookup wrapped in a ClientException says the same', () {
        expect(describe(wrappedLookup), lookupText);
      });

      test('a connection reset keeps the old sentence', () {
        expect(describe(reset), unreachableText);
        expect(describe(const SocketException('Connection reset by peer')), unreachableText);
      });

      test('a timeout keeps the old sentence', () {
        expect(describe(timeout), unreachableText);
      });
    });
  }

  test('the join screen says it for a lookup failure on the LiveKit host', () {
    // room_controller.join(): 'Could not join. ${describeActionError(e)}'.
    expect('Could not join. ${describeActionError(wrappedLookup)}', 'Could not join. $lookupText');
  });

  // The other side: what Dart itself throws for a name that resolves to
  // nothing, not a string written to match the check. .invalid is reserved
  // and never resolves (RFC 2606).
  test('a real failed lookup through the http package is recognised', () async {
    Object? thrown;
    try {
      await http.get(Uri.parse('https://neo-lookup-check.invalid/rtc/validate'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown, isA<http.ClientException>());
    expect(isLookupFailure(thrown!), isTrue, reason: '$thrown');
    expect(describeActionError(thrown), lookupText);
  });
}
