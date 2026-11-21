import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// The moderator's two microphone controls in the control bar, right of
/// Leave, for owners, hosts and moderators:
///   - "Mute all": once (POST /api/livekit/muteAll); people can unmute.
///   - "Lock" / "Unlock": the host sheets' "Lock microphones and cameras"
///     (POST /api/livekit/mic-lock, enforced by LiveKit;
///     mic_lock_test.dart has the rule and the notices).
///
/// Roboto, what Android draws the bar in, from the Flutter SDK: the test
/// font draws every letter as a square and says "Leave" does not fit when
/// it does. False when the SDK's copy cannot be found.
Future<bool> loadRoboto() async {
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root == null) return false;
  final dir = Directory('$root/bin/cache/artifacts/material_fonts');
  if (!dir.existsSync()) return false;
  final loader = FontLoader('Roboto');
  var added = 0;
  for (final name in ['roboto-regular.ttf', 'roboto-medium.ttf', 'roboto-bold.ttf']) {
    final file = File('${dir.path}/$name');
    if (!file.existsSync()) continue;
    loader.addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())));
    added++;
  }
  // Without the regular weight the bar would still be drawn in squares.
  if (added == 0 || !File('${dir.path}/roboto-regular.ttf').existsSync()) return false;
  await loader.load();
  return true;
}

void main() {
  var realFont = false;
  setUpAll(() async => realFont = await loadRoboto());

  group('the control bar', () {
    Widget stage({
      bool micLockOn = false,
      Future<void> Function()? onMuteAll,
      Future<void> Function()? onMicLock,
    }) =>
        MaterialApp(
          home: Scaffold(
            body: MeetingStage(
              room: RoomView(
                title: 'Test',
                people: const [PersonView(id: 'me', name: 'Victor', isMe: true)],
                link: RoomLinkState.live,
                elapsed: const Duration(minutes: 1),
                canManage: onMuteAll != null,
                micLockOn: micLockOn,
              ),
              actions: RoomActions(
                toggleMic: () async {},
                toggleCamera: () async {},
                toggleHand: () async {},
                leave: () async {},
                muteAll: onMuteAll,
                toggleMicLock: onMicLock,
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

    testWidgets('a host sees Mute all, then Lock, right of Leave, and each does its own thing', (tester) async {
      await phone(tester);
      var muted = 0, locked = 0;
      await tester.pumpWidget(stage(onMuteAll: () async => muted++, onMicLock: () async => locked++));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final leave = tester.getRect(find.text('Leave'));
      final muteAll = tester.getRect(find.text('Mute all'));
      final lock = tester.getRect(find.text('Lock'));
      expect(muteAll.left, greaterThan(leave.right), reason: 'Mute all right of Leave');
      expect(lock.left, greaterThan(muteAll.right), reason: 'then the lock');
      expect(lock.right, lessThanOrEqualTo(393));
      expect(find.bySemanticsLabel('Mute everyone'), findsOneWidget);
      expect(find.bySemanticsLabel('Lock microphones and cameras'), findsOneWidget);
      await tester.tap(find.text('Mute all'));
      expect((muted, locked), (1, 0));
      await tester.tap(find.text('Lock'));
      expect((muted, locked), (1, 1));
    });

    testWidgets('while locked the lock reads Unlock, from the server-confirmed state; Mute all stays as it is', (tester) async {
      await phone(tester);
      await tester.pumpWidget(stage(micLockOn: true, onMuteAll: () async {}, onMicLock: () async {}));
      await tester.pump();
      expect(find.text('Unlock'), findsOneWidget);
      expect(find.bySemanticsLabel('Unlock microphones and cameras'), findsOneWidget);
      expect(find.byIcon(Icons.lock_open_rounded), findsOneWidget);
      expect(find.text('Mute all'), findsOneWidget);
    });

    testWidgets('seven buttons on a 360pt phone: none cut short, all on screen', (tester) async {
      if (!realFont) {
        markTestSkipped("no Roboto in FLUTTER_ROOT: widths would be the test font's");
        return;
      }
      await phone(tester, width: 360);
      await tester.pumpWidget(stage(micLockOn: true, onMuteAll: () async {}, onMicLock: () async {}));
      await tester.pump();
      expect(tester.takeException(), isNull);
      for (final label in ['Unlock', 'Mute all', 'Leave', 'Unmute', 'More', 'Video', 'Chat']) {
        final text = tester.renderObject<RenderParagraph>(find.text(label));
        expect(text.didExceedMaxLines, isFalse, reason: '$label is not cut short');
      }
      // Shrunk to fit, still inside the screen.
      expect(tester.getRect(find.text('Unlock')).right, lessThanOrEqualTo(360));
    });

    testWidgets('a participant has neither', (tester) async {
      await phone(tester);
      await tester.pumpWidget(stage());
      await tester.pump();
      expect(find.text('Mute all'), findsNothing);
      expect(find.text('Lock'), findsNothing);
    });
  });
}
