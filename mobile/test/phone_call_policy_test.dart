import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/phone_call_policy.dart';

void main() {
  group('a phone call starting', () {
    test('mutes a live microphone and says why', () {
      final o = decidePhoneCall(inCall: true, micOn: true, mutedByCall: false);

      expect(o.muteMic, isTrue);
      expect(o.mutedByCall, isTrue);
      expect(o.notice, contains('microphone is off'));
    });

    test('leaves an already-muted microphone alone', () {
      final o = decidePhoneCall(inCall: true, micOn: false, mutedByCall: false);

      expect(o.muteMic, isFalse);
      // They muted themselves. Ending the call must not later claim the
      // call did it.
      expect(o.mutedByCall, isFalse);
      expect(o.notice, isNotNull);
    });

    test('a repeated event for the same call keeps the flag', () {
      // Ringing then answered arrives as two "in call" reports. The second
      // sees a muted mic; it must not clear "muted by the call", or hanging
      // up would say nothing and they would not know to unmute.
      final ringing =
          decidePhoneCall(inCall: true, micOn: true, mutedByCall: false);
      final answered = decidePhoneCall(
        inCall: true,
        micOn: false,
        mutedByCall: ringing.mutedByCall,
      );

      expect(answered.muteMic, isFalse);
      expect(answered.mutedByCall, isTrue);
    });
  });

  group('a phone call ending', () {
    test('never turns the microphone back on by itself', () {
      final o = decidePhoneCall(inCall: false, micOn: false, mutedByCall: true);

      // The whole point: whoever just hung up may still be mid-sentence,
      // and a hot microphone at that moment broadcasts it.
      expect(o.muteMic, isFalse);
      expect(o.mutedByCall, isFalse);
      // A banner that stays, not a pop-up: on a real phone Truecaller's
      // after-call screen covered the pop-up for the seconds it lasted.
      expect(o.callEndedMuted, isTrue);
      expect(o.notice, isNull);
    });

    test('says nothing when the call never touched the microphone', () {
      final o = decidePhoneCall(inCall: false, micOn: false, mutedByCall: false);

      expect(o.muteMic, isFalse);
      expect(o.notice, isNull);
      expect(o.callEndedMuted, isNot(isTrue));
    });
  });

  test('a new call puts the call-ended banner away', () {
    final o = decidePhoneCall(inCall: true, micOn: false, mutedByCall: false);
    expect(o.callEndedMuted, isFalse);
  });

  test('a full call from an open microphone ends muted, with the banner', () {
    var micOn = true;
    var muted = false;
    var banner = false;

    for (final inCall in [true, true, false]) {
      final o = decidePhoneCall(inCall: inCall, micOn: micOn, mutedByCall: muted);
      if (o.muteMic) micOn = false;
      muted = o.mutedByCall;
      banner = o.callEndedMuted ?? banner;
    }

    expect(micOn, isFalse, reason: 'must still be muted after hanging up');
    expect(muted, isFalse);
    expect(banner, isTrue);
  });
}
