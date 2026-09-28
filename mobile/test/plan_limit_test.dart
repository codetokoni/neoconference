import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/plan_limit.dart';

/// The pricing page says Free meetings run 60 minutes and Starter 120. The
/// website ended them at that time; the app did not, so on a phone a Free
/// meeting ran for ever. It now counts the owner's minutes as the web
/// does, from the same token metadata.
void main() {
  group('reading the owner\'s plan from the token', () {
    String meta(Map<String, dynamic> limits) =>
        jsonEncode({'planLimits': limits, 'hostPlan': 'free', 'role': 'host'});

    test('Free: 60 minutes, no recording', () {
      final l = MeetingPlanLimits.fromMetadata(meta({'meetingMinutes': 60, 'recording': false}))!;
      expect(l.meetingMinutes, 60);
      expect(l.recording, isFalse);
    });

    test('Pro: no limit, recording', () {
      final l = MeetingPlanLimits.fromMetadata(meta({'meetingMinutes': 0, 'recording': true}))!;
      expect(l.meetingMinutes, 0);
      expect(l.recording, isTrue);
    });

    test('an older token without planLimits says nothing', () {
      expect(MeetingPlanLimits.fromMetadata(jsonEncode({'role': 'host'})), isNull);
      expect(MeetingPlanLimits.fromMetadata(null), isNull);
      expect(MeetingPlanLimits.fromMetadata('not json'), isNull);
    });
  });

  group('the countdown', () {
    test('warns at 5 and 1 minutes left, then ends at the limit', () {
      fakeAsync((clock) {
        final warned = <int>[];
        int? ended;
        final limit = MeetingTimeLimit(onWarn: warned.add, onEnd: (m) => ended = m)..start(60);

        clock.elapse(const Duration(minutes: 54, seconds: 59));
        expect(warned, isEmpty);
        clock.elapse(const Duration(seconds: 1));
        expect(warned, [5]);
        clock.elapse(const Duration(minutes: 4));
        expect(warned, [5, 1]);
        expect(ended, isNull);
        clock.elapse(const Duration(minutes: 1));
        expect(ended, 60);
        expect(limit.running, isFalse);
      });
    });

    test('no limit starts nothing', () {
      fakeAsync((clock) {
        var ended = false;
        final limit = MeetingTimeLimit(onWarn: (_) {}, onEnd: (_) => ended = true)..start(0);
        clock.elapse(const Duration(hours: 10));
        expect(ended, isFalse);
        expect(limit.running, isFalse);
      });
    });

    test('a rejoin after a dropped connection does not restart the clock', () {
      fakeAsync((clock) {
        int? endedAt;
        final limit = MeetingTimeLimit(
          onWarn: (_) {},
          onEnd: (_) => endedAt = clock.elapsed.inMinutes,
        )..start(60);
        clock.elapse(const Duration(minutes: 30));
        limit.start(60); // reconnected: same sitting
        clock.elapse(const Duration(minutes: 30));
        expect(endedAt, 60);
      });
    });

    test('leaving cancels it; joining again counts from the start', () {
      fakeAsync((clock) {
        var ends = 0;
        final limit = MeetingTimeLimit(onWarn: (_) {}, onEnd: (_) => ends++)..start(60);
        clock.elapse(const Duration(minutes: 50));
        limit.cancel();
        limit.start(60);
        clock.elapse(const Duration(minutes: 59));
        expect(ends, 0);
        clock.elapse(const Duration(minutes: 1));
        expect(ends, 1);
      });
    });
  });

  test('the ending says why, and how to get longer meetings', () {
    final drop = timeLimitDrop(60);
    expect(drop.headline, 'Time limit reached');
    expect(drop.message, contains('60-minute limit'));
    expect(drop.message, contains('neoconference.app/pricing'));
    expect(drop.retryAutomatically, isFalse);
  });
}
