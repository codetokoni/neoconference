import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart' show ParticipantPermissions;
// ignore: implementation_imports
import 'package:livekit_client/src/proto/livekit_models.pb.dart' as lk_models;
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// "Mute everyone" / "Unmute everyone": a meeting-wide microphone lock the
/// server enforces through LiveKit (POST /api/livekit/micLock). The app reads
/// it from the room's metadata and from what LiveKit lets this device
/// publish, and shows the toggle right of Leave to owners, hosts and
/// moderators.
/// Roboto, what Android draws the bar in, from the Flutter SDK: the test
/// font draws every letter as a square and says "Leave" does not fit when
/// it does. False when the SDK's copy cannot be found.
Future<bool> loadRoboto() async {
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root == null) return false;
  final dir = Directory('$root/bin/cache/artifacts/material_fonts');
  if (!dir.existsSync()) return false;
  final loader = FontLoader('Roboto');
  for (final name in ['roboto-regular.ttf', 'roboto-medium.ttf', 'roboto-bold.ttf']) {
    final file = File('${dir.path}/$name');
    if (file.existsSync()) loader.addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())));
  }
  await loader.load();
  return true;
}

void main() {
  var realFont = false;
  setUpAll(() async => realFont = await loadRoboto());

  group('reading the lock', () {
    test('the room metadata says which way it went', () {
      expect(roomMicLock('{"micLock":true}'), isTrue);
      expect(roomMicLock('{"micLock":false,"other":1}'), isFalse);
      expect(roomMicLock(null), isNull);
      expect(roomMicLock('not json'), isNull);
      expect(roomMicLock('{"micLock":"yes"}'), isNull);
    });

    test('a microphone left out of what this device may publish is locked', () {
      const s = lk_models.TrackSource.values;
      ParticipantPermissions perms(List<lk_models.TrackSource> sources) =>
          ParticipantPermissions(canPublish: true, canPublishSources: sources);
      final camera = s.firstWhere((x) => x.value == 1);
      final mic = s.firstWhere((x) => x.value == 2);
      final screen = s.firstWhere((x) => x.value == 3);
      expect(micLockedBy(perms([camera, screen])), isTrue);
      expect(micLockedBy(perms([camera, mic, screen])), isFalse);
      // No list at all allows everything: the usual, unlocked case.
      expect(micLockedBy(perms(const [])), isFalse);
      expect(micLockedBy(null), isFalse);
    });
  });

  group('the control bar', () {
    Widget stage({
      bool everyoneMuted = false,
      bool micLocked = false,
      Future<void> Function()? onEveryoneMuted,
    }) =>
        MaterialApp(
          home: Scaffold(
            body: MeetingStage(
              room: RoomView(
                title: 'Test',
                people: const [PersonView(id: 'me', name: 'Victor', isMe: true)],
                link: RoomLinkState.live,
                elapsed: const Duration(minutes: 1),
                canManage: onEveryoneMuted != null,
                everyoneMuted: everyoneMuted,
                micLocked: micLocked,
              ),
              actions: RoomActions(
                toggleMic: () async {},
                toggleCamera: () async {},
                toggleHand: () async {},
                leave: () async {},
                toggleEveryoneMuted: onEveryoneMuted,
              ),
            ),
          ),
        );

    Future<void> phone(WidgetTester tester, {double width = 393}) async {
      // A 393pt phone, the width that once pushed Leave off the edge.
      tester.view.physicalSize = Size(width * 3, 852 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
    }

    testWidgets('a host sees Mute all right of Leave, and it fits on a phone', (tester) async {
      await phone(tester);
      var pressed = 0;
      await tester.pumpWidget(stage(onEveryoneMuted: () async => pressed++));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final leave = tester.getRect(find.text('Leave'));
      final muteAll = tester.getRect(find.text('Mute all'));
      expect(muteAll.left, greaterThan(leave.right), reason: 'immediately right of Leave');
      expect(muteAll.right, lessThanOrEqualTo(393));
      expect(find.bySemanticsLabel('Mute everyone'), findsOneWidget);
      await tester.tap(find.text('Mute all'));
      expect(pressed, 1);
    });

    testWidgets('while locked it reads Unmute all, from the server-confirmed state', (tester) async {
      await phone(tester);
      await tester.pumpWidget(stage(everyoneMuted: true, onEveryoneMuted: () async {}));
      await tester.pump();
      expect(find.text('Unmute all'), findsOneWidget);
      expect(find.bySemanticsLabel('Unmute everyone'), findsOneWidget);
      expect(find.byIcon(Icons.mic_rounded), findsOneWidget, reason: 'microphone-on icon to unmute');
    });

    testWidgets('Unmute all is not cut short on a 360pt phone', (tester) async {
      if (!realFont) {
        markTestSkipped("no Roboto in FLUTTER_ROOT: widths would be the test font's");
        return;
      }
      await phone(tester, width: 360);
      await tester.pumpWidget(stage(everyoneMuted: true, onEveryoneMuted: () async {}));
      await tester.pump();
      expect(tester.takeException(), isNull);
      for (final label in ['Unmute all', 'Leave', 'Unmute', 'More']) {
        final text = tester.renderObject<RenderParagraph>(find.text(label));
        expect(text.didExceedMaxLines, isFalse, reason: '$label is not cut short');
      }
      // Shrunk to fit, still inside the screen.
      expect(tester.getRect(find.text('Unmute all')).right, lessThanOrEqualTo(360));
    });

    testWidgets('a participant has no such button', (tester) async {
      await phone(tester);
      await tester.pumpWidget(stage());
      await tester.pump();
      expect(find.text('Mute all'), findsNothing);
      expect(find.text('Unmute all'), findsNothing);
    });

    testWidgets("a locked participant's microphone says so", (tester) async {
      await phone(tester);
      await tester.pumpWidget(stage(micLocked: true));
      await tester.pump();
      expect(find.text('Locked'), findsOneWidget);
      expect(find.bySemanticsLabel('Microphone muted by the host'), findsOneWidget);
    });
  });
}
