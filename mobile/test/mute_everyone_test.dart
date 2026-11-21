import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// "Mute everyone" / "Unmute everyone" in the control bar, right of Leave:
/// the host sheets' "Lock participant microphones" (POST /api/livekit/mic-lock,
/// enforced by LiveKit; mic_lock_test.dart has the rule and the notices),
/// for owners, hosts and moderators.
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

  group('the control bar', () {
    Widget stage({
      bool micLockOn = false,
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
                micLockOn: micLockOn,
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
      await tester.pumpWidget(stage(micLockOn: true, onEveryoneMuted: () async {}));
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
      await tester.pumpWidget(stage(micLockOn: true, onEveryoneMuted: () async {}));
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
  });
}
