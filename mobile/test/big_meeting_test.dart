import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/big_meeting.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// Big-meeting receiving on the phone (room/big_meeting.dart), as the web
/// room does it: in the SA meeting of 23 November 2026 phones could not take
/// every microphone and camera of 638 people, and rejoined over and over.
void main() {
  PubInfo mic(String id, {bool muted = false}) =>
      PubInfo(key: '$id/mic', identity: id, audio: true, source: PubSource.microphone, muted: muted);
  PubInfo cam(String id) =>
      PubInfo(key: '$id/cam', identity: id, audio: false, source: PubSource.camera, muted: false);
  List<String> on(Map<String, bool> plan) =>
      (plan.entries.where((e) => e.value).map((e) => e.key).toList()..sort());

  group('what one phone receives', () {
    test('muted microphones are never received; unmuted ones are', () {
      final plan = receivePlan([mic('a'), mic('b', muted: true), mic('c')]);
      expect(on(plan), ['a/mic', 'c/mic']);
      expect(plan['b/mic'], isFalse);
    });

    test('at most $maxAudio microphones: Hosts and Moderators first, then whoever spoke or unmuted last', () {
      final people = [for (var i = 0; i < 30; i++) mic('p$i'), mic('host')];
      final spokeAt = {'p29': 900, 'p3': 800};
      final liveAt = {'p7/mic': 850};
      final heard = on(receivePlan(people, spokeAt: spokeAt, liveAt: liveAt, priority: {'host'}));
      expect(heard, hasLength(maxAudio));
      expect(heard, containsAll(['host/mic', 'p29/mic', 'p7/mic', 'p3/mic']));
      final later = receivePlan(people, spokeAt: {...spokeAt, 'p15': 1000}, liveAt: liveAt, priority: {'host'});
      expect(later['p15/mic'], isTrue, reason: 'someone who starts speaking is heard');
      expect(on(later), hasLength(maxAudio));
    });

    test('cameras only while their tile is shown, at most $maxVideo; screen shares always', () {
      const share = PubInfo(key: 's/share', identity: 's', audio: false, source: PubSource.screenShare, muted: false);
      const shareAudio = PubInfo(key: 's/sa', identity: 's', audio: true, source: PubSource.screenShareAudio, muted: false);
      final plan = receivePlan([cam('a'), cam('b'), share, shareAudio], shown: {'a'});
      expect(on(plan), ['a/cam', 's/sa', 's/share']);
      expect(plan['b/cam'], isFalse);
      final many = [for (var i = 0; i < 40; i++) cam('v$i')];
      expect(on(receivePlan(many, shown: {for (final c in many) c.identity})), hasLength(maxVideo));
    });

    test("the token's answer is read safely: anything unexpected is receive-all, not muted", () {
      final m = ReceiveMode.of({'receive': 'selective', 'joinMuted': true});
      expect([m.selective, m.joinMuted], [true, true]);
      for (final body in <Map<String, dynamic>>[{}, {'receive': 'SELECTIVE'}, {'joinMuted': 'true'}, {'receive': 'all'}]) {
        final x = ReceiveMode.of(body);
        expect([x.selective, x.joinMuted], [false, false], reason: '$body');
      }
    });
  });

  group('asking LiveKit', () {
    late List<String> asked;
    PlanTarget target(String key, {bool subscribed = false}) => PlanTarget(
          info: PubInfo(key: key, identity: key, audio: true, source: PubSource.microphone, muted: false),
          subscribed: subscribed,
          set: (want) async => asked.add('${want ? 'sub' : 'unsub'} $key'),
        );
    setUp(() => asked = []);

    test('asks once for each change, not again while the track is on its way', () {
      final a = ReceiveApplier();
      expect(a.apply([target('m1'), target('m2')], {'m1': true, 'm2': false}), 1);
      expect(asked, ['sub m1'], reason: 'm2 is already not received');
      expect(a.apply([target('m1'), target('m2')], {'m1': true, 'm2': false}), 0, reason: 'm1 not arrived yet: not asked again');
      expect(a.apply([target('m1', subscribed: true)], {'m1': true}), 0);
      a.apply([target('m1', subscribed: true)], {'m1': false});
      expect(asked, ['sub m1', 'unsub m1']);
    });

    test('a new connection, or a publication that went and came back, is asked again', () {
      final a = ReceiveApplier();
      a.apply([target('m1')], {'m1': true});
      a.reset();
      a.apply([target('m1')], {'m1': true});
      a.apply([], {});
      a.apply([target('m1')], {'m1': true});
      expect(asked, ['sub m1', 'sub m1', 'sub m1']);
    });
  });

  test('the meeting is wired to it: how it connects, entering muted, and re-planning on changes', () {
    final src = File('lib/src/room/room_controller.dart').readAsStringSync();
    expect(src, contains('_receive = ReceiveMode.of(creds);'));
    expect(src, contains('connectOptions: ConnectOptions(autoSubscribe: !_receive.selective)'));
    expect(src, contains('ShownTiles.instance.addListener(_schedulePlan);'));
    expect(src, contains('if (_receive.joinMuted) {'));
    expect(src, contains('state = state.copyWith(message: joinedMutedMessage);'));
    for (final e in ['TrackPublishedEvent', 'TrackUnmutedEvent', 'TrackMutedEvent', 'TrackUnpublishedEvent', 'ParticipantConnectedEvent', 'ParticipantDisconnectedEvent']) {
      expect(src, contains('..on<$e>('), reason: e);
    }
    expect(File('lib/src/screens/meeting_stage.dart').readAsStringSync(), contains('ShownTile(id: person.id, child: _tile(context))'));
  });

  group('which tiles are shown', () {
    setUp(ShownTiles.instance.clear);

    testWidgets('only the tiles on or near the screen; scrolling changes who', (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      const me = PersonView(id: 'me', name: 'Victor', isMe: true);
      final people = [me, for (var i = 0; i < 60; i++) PersonView(id: 'p$i#1', name: 'Person $i')];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: NeoTheme(
            palette: NeoPalette.dark,
            child: MeetingStage(
              room: RoomView(title: 'SA meeting', people: people, link: RoomLinkState.live, elapsed: Duration.zero, canManage: false),
              actions: RoomActions(toggleMic: () async {}, toggleCamera: () async {}, toggleHand: () async {}, leave: () async {}),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      if (find.byTooltip('Grid view').evaluate().isNotEmpty) {
        await tester.tap(find.byTooltip('Grid view'));
        await tester.pumpAndSettle();
      }
      final first = ShownTiles.instance.ids;
      expect(first, contains('p0#1'));
      expect(first.length, lessThan(people.length), reason: 'tiles far down the grid are not built');
      expect(first, isNot(contains('p59#1')));

      await tester.drag(find.byType(GridView), const Offset(0, -6000));
      await tester.pumpAndSettle();
      final later = ShownTiles.instance.ids;
      expect(later, contains('p59#1'), reason: 'scrolled to');
      expect(later, isNot(contains('p0#1')), reason: 'scrolled away');
    });

    testWidgets('a person with two tiles stays shown until both are gone', (tester) async {
      Widget two(bool both) => Directionality(
            textDirection: TextDirection.ltr,
            child: Column(children: [
              const ShownTile(id: 'x', child: SizedBox()),
              if (both) const ShownTile(id: 'x', child: SizedBox()),
            ]),
          );
      await tester.pumpWidget(two(true));
      expect(ShownTiles.instance.ids, {'x'});
      await tester.pumpWidget(two(false));
      expect(ShownTiles.instance.ids, {'x'});
      await tester.pumpWidget(const SizedBox());
      expect(ShownTiles.instance.ids, isEmpty);
    });
  });
}
