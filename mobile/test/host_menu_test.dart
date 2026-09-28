import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// Who runs the meeting, and what a host can do to someone, on the phone.
///
/// The web labels hosts on their tiles and opens a menu of host actions
/// on each one; the app showed neither. Roles travel in every
/// participant's LiveKit metadata, which the server rewrites on promotion.
void main() {
  group('roles from metadata', () {
    test('reads the role the token route writes', () {
      expect(participantRole('{"role":"host","hostPlan":"free"}'), 'host');
      expect(participantRole('{"role":"cohost"}'), 'cohost');
    });

    test('nothing to read is no role, not a crash', () {
      expect(participantRole(null), isNull);
      expect(participantRole(''), isNull);
      expect(participantRole('not json'), isNull);
      expect(participantRole('{"planLimits":{}}'), isNull);
    });

    test('the owner is marked apart from the host role', () {
      expect(participantIsOwner('{"role":"host","owner":true}'), isTrue);
      expect(participantIsOwner('{"role":"host"}'), isFalse);
      expect(participantIsOwner(null), isFalse);
    });

    test('tiles name owner, host and moderator, and nobody else', () {
      const base = PersonView(id: 'a', name: 'A');
      expect(const PersonView(id: 'a', name: 'A', role: 'host', owner: true).roleLabel, 'Owner');
      expect(const PersonView(id: 'a', name: 'A', role: 'host').roleLabel, 'Host');
      expect(const PersonView(id: 'a', name: 'A', role: 'cohost').roleLabel, 'Moderator');
      expect(const PersonView(id: 'a', name: 'A', role: 'attendee').roleLabel, isNull);
      expect(base.roleLabel, isNull);
    });
  });

  group('the meeting screen', () {
    const me = PersonView(id: 'me', name: 'Victor', isMe: true, role: 'host', owner: true);
    const other = PersonView(id: 'user_2#1', name: 'Grace', role: 'cohost');

    Widget stage(RoomActions actions) => MaterialApp(
          home: Scaffold(
            body: MeetingStage(
              room: const RoomView(
                title: 'Test',
                people: [me, other],
                link: RoomLinkState.live,
                elapsed: Duration(minutes: 1),
                canManage: true,
              ),
              actions: actions,
            ),
          ),
        );

    RoomActions actions({
      void Function(PersonView)? onPerson,
      VoidCallback? onMic,
      VoidCallback? onCamera,
    }) =>
        RoomActions(
          toggleMic: () async {},
          toggleCamera: () async {},
          toggleHand: () async {},
          leave: () async {},
          openPersonMenu: onPerson,
          openMicPicker: onMic,
          openCameraPicker: onCamera,
        );

    testWidgets('each tile shows its person\'s role', (tester) async {
      await tester.pumpWidget(stage(actions()));
      await tester.pump();
      expect(find.text('Owner'), findsOneWidget);
      expect(find.text('Moderator'), findsOneWidget);
    });

    testWidgets('holding someone\'s tile opens their host menu', (tester) async {
      PersonView? opened;
      await tester.pumpWidget(stage(actions(onPerson: (p) => opened = p)));
      await tester.pump();

      await tester.longPress(find.text('Grace'));
      await tester.pump();
      expect(opened?.id, 'user_2#1');
    });

    testWidgets('holding your own tile does nothing', (tester) async {
      PersonView? opened;
      await tester.pumpWidget(stage(actions(onPerson: (p) => opened = p)));
      await tester.pump();

      await tester.longPress(find.text('You'));
      await tester.pump();
      expect(opened, isNull);
    });

    testWidgets('the ▾ on Microphone and Camera opens their pickers', (tester) async {
      var mic = 0;
      var camera = 0;
      await tester.pumpWidget(stage(actions(onMic: () => mic++, onCamera: () => camera++)));
      await tester.pump();

      await tester.tap(find.bySemanticsLabel('Choose microphone and speaker'));
      await tester.tap(find.bySemanticsLabel('Choose camera'));
      await tester.pump();
      expect(mic, 1);
      expect(camera, 1);
    });
  });
}
