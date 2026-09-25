import 'package:flutter/foundation.dart';

/// What the meeting should do when a phone call starts or ends.
@immutable
class PhoneCallOutcome {
  const PhoneCallOutcome({
    required this.muteMic,
    required this.mutedByCall,
    this.notice,
    this.callEndedMuted,
  });

  /// Turn the microphone off now.
  final bool muteMic;

  /// Whether the microphone is off *because of* a call, so that ending
  /// the call knows whether there is anything to tell the person.
  final bool mutedByCall;

  /// What to tell them, or null for nothing.
  final String? notice;

  /// Whether the "call ended, your microphone is still off" banner should
  /// show. Null leaves it as it is.
  ///
  /// A banner, not the pop-up this used to be: a pop-up is gone in a few
  /// seconds, and on a real phone Truecaller's after-call screen covered
  /// the meeting for exactly those seconds.
  final bool? callEndedMuted;
}

/// Decide how a meeting reacts to a phone call.
///
/// Pure, because this is the part worth getting right and it can be tested
/// without placing a call.
///
/// A call mutes the microphone if it was on: the ringtone and then one
/// side of a private conversation would otherwise go out to the meeting.
/// The end of a call deliberately does **not** turn it back on. Someone
/// hanging up is still mid-sentence with whoever they were talking to, and
/// a hot microphone at that instant broadcasts it. They are told instead,
/// and unmute when they are ready — which also restarts the capture that
/// Android handed to the call.
PhoneCallOutcome decidePhoneCall({
  required bool inCall,
  required bool micOn,
  required bool mutedByCall,
}) {
  if (inCall) {
    if (micOn) {
      return const PhoneCallOutcome(
        muteMic: true,
        mutedByCall: true,
        notice: 'You\'re on a phone call. Your microphone is off in the '
            'meeting.',
        callEndedMuted: false,
      );
    }
    // Already muted — by them, or by an earlier event for this same call.
    // Either way nothing to switch off, and the flag is left as it was so
    // a repeated event cannot turn "muted by the call" into "muted by you".
    return PhoneCallOutcome(
      muteMic: false,
      mutedByCall: mutedByCall,
      notice: 'You\'re on a phone call.',
      callEndedMuted: false,
    );
  }

  if (mutedByCall) {
    return const PhoneCallOutcome(
      muteMic: false,
      mutedByCall: false,
      callEndedMuted: true,
    );
  }

  // The call ended and it never touched the microphone: they were muted
  // already, so there is nothing to restore and nothing worth saying.
  return const PhoneCallOutcome(muteMic: false, mutedByCall: false);
}
