import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:neoconference/src/room/meeting_drop.dart';

void main() {
  test('leaving on purpose explains nothing', () {
    expect(describeDrop(DisconnectReason.clientInitiated), isNull);
  });

  test('losing the network offers Rejoin, whatever form it took', () {
    // Measured on an emulator: cutting the link until LiveKit gives up.
    // Every client-side flavour of "the network went" must read the same.
    for (final reason in [
      null,
      DisconnectReason.unknown,
      DisconnectReason.disconnected,
      DisconnectReason.signalClose,
      DisconnectReason.signalingConnectionFailure,
      DisconnectReason.reconnectAttemptsExceeded,
      DisconnectReason.serverShutdown,
      DisconnectReason.stateMismatch,
      DisconnectReason.joinFailure,
      DisconnectReason.migration,
    ]) {
      final drop = describeDrop(reason)!;
      expect(drop.headline, 'You were disconnected', reason: '$reason');
      expect(drop.canRejoin, isTrue, reason: '$reason');
      expect(drop.retryAutomatically, isTrue, reason: '$reason');
    }
  });

  test('a meeting that was ended or a person who was removed cannot rejoin',
      () {
    final ended = describeDrop(DisconnectReason.roomDeleted)!;
    final removed = describeDrop(DisconnectReason.participantRemoved)!;
    expect(ended.headline, 'The meeting has ended');
    expect(ended.canRejoin, isFalse);
    expect(removed.headline, 'You were removed from the meeting');
    expect(removed.canRejoin, isFalse);
    expect(ended.retryAutomatically, isFalse);
    expect(removed.retryAutomatically, isFalse);
  });

  test('joining from another device can be taken back', () {
    final elsewhere = describeDrop(DisconnectReason.duplicateIdentity)!;
    expect(elsewhere.headline, 'Joined on another device');
    expect(elsewhere.canRejoin, isTrue);
    // Retrying by itself would take the seat back from the other device,
    // which would then retry too.
    expect(elsewhere.retryAutomatically, isFalse);
  });

  test('no reason is left saying "Could not join"', () {
    for (final reason in DisconnectReason.values) {
      expect(describeDrop(reason)?.headline, isNot('Could not join'));
    }
  });
}
