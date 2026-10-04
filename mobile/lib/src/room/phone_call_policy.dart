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

/// Where the meeting's sound was before a phone call, put back after it.
///
/// Reported from a phone: in a meeting on the loudspeaker, a call came in
/// (or was made), and when it ended the meeting stayed on the earpiece.
/// Android hands the audio to the call and, when the call ends, does not
/// give the speaker back; the app never asked for it again.
///
/// The route is put back twice: as soon as the call ends, and once more a
/// moment later, because Android finishes tearing the call's audio down
/// after it reports the call over, and can undo a route set too early.
class CallRoute {
  CallRoute({
    required this.apply,
    this.settle = const Duration(milliseconds: 1500),
    Future<void> Function(Duration)? wait,
  }) : _wait = wait ?? Future<void>.delayed;

  /// Puts the sound on the loudspeaker (true) or off it (false).
  final Future<void> Function(bool speaker) apply;

  /// How long after the call ends to put the route back a second time.
  final Duration settle;

  final Future<void> Function(Duration) _wait;

  bool? _speakerBefore;

  /// Whether a call's route is being kept.
  bool get holding => _speakerBefore != null;

  /// A call started: remember where the sound was. Only the first report
  /// of a call counts — a second "ringing" must not record the earpiece
  /// the call itself moved the sound to.
  void callStarted({required bool speakerOn}) {
    _speakerBefore ??= speakerOn;
  }

  /// The call ended: put the sound back where it was.
  Future<void> callEnded() async {
    final speaker = _speakerBefore;
    _speakerBefore = null;
    if (speaker == null) return;
    await apply(speaker);
    await _wait(settle);
    // A newer call started meanwhile: that one owns the route now.
    if (_speakerBefore != null) return;
    await apply(speaker);
  }
}
