import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/phone_call_policy.dart';

/// Reported from a phone: on the loudspeaker in a meeting, a call came in,
/// and when it ended the meeting stayed on the earpiece.
void main() {
  CallRoute route(List<bool> applied, {List<Duration>? waits}) => CallRoute(
        apply: (speaker) async => applied.add(speaker),
        wait: (d) async => waits?.add(d),
      );

  test('the speaker comes back after the call, twice to make it stick', () async {
    final applied = <bool>[];
    final waits = <Duration>[];
    final r = route(applied, waits: waits);

    r.callStarted(speakerOn: true);
    await r.callEnded();

    expect(applied, [true, true]);
    expect(waits, [const Duration(milliseconds: 1500)]);
    expect(r.holding, isFalse);
  });

  test('the earpiece stays the earpiece', () async {
    final applied = <bool>[];
    final r = route(applied);
    r.callStarted(speakerOn: false);
    await r.callEnded();
    expect(applied, [false, false]);
  });

  test('a second report of the same call does not record the call\'s own route', () async {
    final applied = <bool>[];
    final r = route(applied);
    r.callStarted(speakerOn: true); // ringing, on the speaker
    r.callStarted(speakerOn: false); // answered: the call moved it
    await r.callEnded();
    expect(applied, everyElement(isTrue));
  });

  test('a call ending that never started changes nothing', () async {
    final applied = <bool>[];
    await route(applied).callEnded();
    expect(applied, isEmpty);
  });

  test('a new call during the settle wait keeps its own route', () async {
    final applied = <bool>[];
    late CallRoute r;
    r = CallRoute(
      apply: (speaker) async => applied.add(speaker),
      wait: (_) async => r.callStarted(speakerOn: false),
    );
    r.callStarted(speakerOn: true);
    await r.callEnded();
    expect(applied, [true]);
    expect(r.holding, isTrue);
  });
}
