import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';

/// Why the meeting ended under this person, in words they can act on.
///
/// Before this, every way of losing a meeting landed on the join screen's
/// failure state: "Could not join", with Try again. For someone who had
/// been in the meeting for twenty minutes when their signal went, that is
/// the wrong story — they did join, and what they want is back in.
@immutable
class MeetingDrop {
  const MeetingDrop({
    required this.headline,
    required this.message,
    required this.canRejoin,
    this.retryAutomatically = false,
  });

  final String headline;
  final String message;

  /// Whether a Rejoin button makes sense. A host who ended the meeting or
  /// removed this person is not undone by pressing it.
  final bool canRejoin;

  /// Whether the app should get back in by itself. Only for the network:
  /// a meeting that was ended or a person who was removed cannot, and
  /// retrying after "joined on another device" would fight that device
  /// for the seat.
  final bool retryAutomatically;
}

/// Null when the person left on purpose — there is nothing to explain.
///
/// LiveKit's reasons split three ways. The server ended it for everyone,
/// or took this person out of it: say so, and offer no way back. The same
/// account joined elsewhere: say so, and let them take it back. Everything
/// else is the network in one form or another, and the answer to all of
/// them is the same.
MeetingDrop? describeDrop(DisconnectReason? reason) => switch (reason) {
      DisconnectReason.clientInitiated => null,
      DisconnectReason.roomDeleted => const MeetingDrop(
          headline: 'The meeting has ended',
          message: 'It was closed for everyone.',
          canRejoin: false,
        ),
      DisconnectReason.participantRemoved => const MeetingDrop(
          headline: 'You were removed from the meeting',
          message: 'A host took you out of this meeting.',
          canRejoin: false,
        ),
      DisconnectReason.duplicateIdentity => const MeetingDrop(
          headline: 'Joined on another device',
          message: 'Your account joined this meeting somewhere else, so it '
              'was closed here.',
          canRejoin: true,
        ),
      _ => const MeetingDrop(
          headline: 'You were disconnected',
          message: 'The connection to the meeting was lost.',
          canRejoin: true,
          retryAutomatically: true,
        ),
    };
