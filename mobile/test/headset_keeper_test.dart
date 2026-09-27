import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/headset_keeper.dart';

void main() {
  // Found on a phone with earbuds (M02_7FF3): the meeting went onto their
  // headset link, KingsChat claimed call audio, the earbuds closed that
  // link, and the call sat on their media link — microphone on the phone —
  // for the rest of the meeting.
  const headset = CallAudio(route: 'bluetooth', headset: 'M02_7FF3');
  const mediaOnly = CallAudio(route: 'bluetooth_media', headset: 'M02_7FF3');
  const gone = CallAudio(route: 'speaker');
  final t0 = DateTime(2026, 9, 27, 9, 12);

  HeadsetAction step(HeadsetKeeper k, CallAudio a, int seconds, {bool speaker = false}) =>
      k.changed(a, t0.add(Duration(seconds: seconds)), speakerChosen: speaker);

  test('a dropped headset link is asked back', () {
    final k = HeadsetKeeper();
    expect(step(k, headset, 0), HeadsetAction.none);
    expect(step(k, mediaOnly, 59), HeadsetAction.reclaim);
  });

  test('dropping again right after being asked back means someone else wants it', () {
    final k = HeadsetKeeper();
    step(k, headset, 0);
    expect(step(k, mediaOnly, 59), HeadsetAction.reclaim);
    expect(step(k, headset, 62), HeadsetAction.none);
    expect(step(k, mediaOnly, 69), HeadsetAction.giveUp);
    // And it stays given up: no flipping back and forth.
    expect(step(k, headset, 80), HeadsetAction.none);
    expect(step(k, mediaOnly, 200), HeadsetAction.none);
    expect(k.gaveUp, isTrue);
  });

  test('a drop long after the last one is just a new drop', () {
    final k = HeadsetKeeper();
    step(k, headset, 0);
    step(k, mediaOnly, 10);
    step(k, headset, 12);
    expect(step(k, mediaOnly, 10 + 61), HeadsetAction.reclaim);
  });

  test('choosing the speaker is not a drop', () {
    final k = HeadsetKeeper();
    step(k, headset, 0);
    expect(step(k, gone, 5, speaker: true), HeadsetAction.none);
  });

  test('earbuds that disconnected are not asked back', () {
    final k = HeadsetKeeper();
    step(k, headset, 0);
    expect(step(k, gone, 5), HeadsetAction.none);
  });

  test('a meeting never on the headset is left alone', () {
    final k = HeadsetKeeper();
    expect(step(k, mediaOnly, 0), HeadsetAction.none);
  });

  test('choosing the headset by hand starts over after giving up', () {
    final k = HeadsetKeeper();
    step(k, headset, 0);
    step(k, mediaOnly, 1);
    step(k, headset, 2);
    step(k, mediaOnly, 3);
    expect(k.gaveUp, isTrue);
    k.chosen();
    step(k, headset, 100);
    expect(step(k, mediaOnly, 200), HeadsetAction.reclaim);
  });

  test('the platform map is read, and a missing one is harmless', () {
    final a = CallAudio.fromMap({'route': 'bluetooth', 'headset': 'M02_7FF3'});
    expect(a.onHeadset, isTrue);
    expect(a.headset, 'M02_7FF3');
    expect(CallAudio.fromMap(null).route, isNull);
  });
}
