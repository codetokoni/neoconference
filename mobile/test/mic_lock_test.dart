import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart' show DataReceivedEvent, ParticipantPermissions;
// ignore: implementation_imports
import 'package:livekit_client/src/proto/livekit_models.pb.dart' as lk;
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/person_sheets.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// Locked participant microphones in the app (the server's
/// src/lib/micLock.ts). The server takes the microphone out of LiveKit's
/// permission and LiveKit enforces it; the app shows the lock, says why,
/// never tries to unmute while locked, and offers an Owner, Host or Moderator
/// "Allow to unmute" and "Lock microphone again".
class _Room extends RoomController {
  _Room(RoomState initial) : super(api: ApiClient(token: () async => null), slug: 't') {
    state = initial;
  }

  final calls = <String>[];

  @override
  Future<void> allowToUnmute(String identity) async => calls.add('allow $identity');

  @override
  Future<void> lockMicrophoneAgain(String identity) async => calls.add('relock $identity');

  void send(Map<String, Object?> payload) => receiveData(
        DataReceivedEvent(participant: null, data: utf8.encode(jsonEncode(payload)), topic: 'mic_lock'),
      );
}

const _locked = ParticipantPermissions(
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
  canPublishSources: [lk.TrackSource.CAMERA, lk.TrackSource.SCREEN_SHARE, lk.TrackSource.SCREEN_SHARE_AUDIO],
);
const _open = ParticipantPermissions(canPublish: true, canSubscribe: true, canPublishData: true);
/// Allowed to talk while the meeting is locked (src/lib/micLock.ts "mic").
const _micOnly = ParticipantPermissions(canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [lk.TrackSource.MICROPHONE]);

void main() {
  late _Room room;

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  group('the rule', () {
    test('locked when LiveKit allows no publishing in the meeting (or, as before, not the microphone)', () {
      expect(micLockedBy(_locked), isTrue);
      // The lock now: nothing may be published (microphone, camera, screen).
      expect(micLockedBy(const ParticipantPermissions(canPublishData: true, canSubscribe: true)), isTrue);
      expect(micLockedBy(_open), isFalse);
      expect(
        micLockedBy(const ParticipantPermissions(canPublish: true, canPublishSources: [lk.TrackSource.MICROPHONE, lk.TrackSource.CAMERA])),
        isFalse,
      );
      // Before joining LiveKit reports no publishing at all: not a lock.
      expect(micLockedBy(const ParticipantPermissions(), joined: false), isFalse);
      expect(micLockedBy(null), isFalse);
    });

    test('allowed to talk while locked: the microphone is free, the camera locked', () {
      expect(micLockedBy(_micOnly), isFalse);
      expect(camLockedBy(_micOnly), isTrue);
      expect(camLockedBy(const ParticipantPermissions(canPublishData: true)), isTrue, reason: 'locked: nothing at all');
      expect(camLockedBy(const ParticipantPermissions(), joined: false), isFalse, reason: 'before joining');
      expect(camLockedBy(_open), isFalse);
    });
  });

  group('the person whose microphone is locked', () {
    testWidgets('is told when it is locked, and when they may unmute again', (tester) async {
      await tester.runAsync(() async => room = _Room(const RoomState(role: 'attendee')));
      room.syncMicLock(_locked);
      expect(room.state.micLocked, isTrue);
      expect(room.state.message, 'Your microphone and camera are locked. An Owner, Host, or Moderator can allow you to turn them on.');
      room.syncMicLock(_open);
      expect(room.state.micLocked, isFalse);
      expect(room.state.message, 'You can now turn your microphone and camera on.');
      // Allowed is not unmuted: the microphone stays off until they choose.
      expect(room.state.micOn, isFalse);
    });

    testWidgets('tapping Unmute while locked does not unmute, and says why', (tester) async {
      await tester.runAsync(() async => room = _Room(const RoomState(role: 'attendee', micLocked: true)));
      await room.toggleMic();
      expect(room.state.micOn, isFalse);
      expect(room.state.message, kMicLockedMessage);
    });

    testWidgets('the Mic and Video buttons show the lock', (tester) async {
      Widget stage(bool locked, {bool? camLocked}) => MaterialApp(
            home: Scaffold(
              body: MeetingStage(
                room: RoomView(
                  title: 'Test',
                  people: const [PersonView(id: 'me', name: 'Ann', isMe: true)],
                  link: RoomLinkState.live,
                  elapsed: const Duration(minutes: 1),
                  micLocked: locked,
                  camLocked: camLocked ?? locked,
                ),
                actions: RoomActions(
                  toggleMic: () async {},
                  toggleCamera: () async {},
                  toggleHand: () async {},
                  leave: () async {},
                ),
              ),
            ),
          );
      await tester.pumpWidget(stage(true));
      await tester.pump();
      // Microphone and camera both: the lock takes everything they could send.
      expect(find.text('Locked'), findsNWidgets(2));
      expect(find.byIcon(Icons.lock_rounded), findsNWidgets(2));
      await tester.pumpWidget(stage(false));
      await tester.pump();
      expect(find.text('Unmute'), findsOneWidget);
      expect(find.text('Video'), findsOneWidget);
      expect(find.byIcon(Icons.lock_rounded), findsNothing);
      // Allowed to talk while still locked: the microphone is theirs, the camera not.
      await tester.pumpWidget(stage(false, camLocked: true));
      await tester.pump();
      expect(find.text('Unmute'), findsOneWidget);
      expect(find.text('Locked'), findsOneWidget);
      expect(find.byIcon(Icons.lock_rounded), findsOneWidget);
    });

    testWidgets('allowed to talk: told the camera stays locked, and the camera refuses with its own words', (tester) async {
      await tester.runAsync(() async => room = _Room(const RoomState(role: 'attendee')));
      room.syncMicLock(_locked);
      room.syncMicLock(_micOnly);
      expect((room.state.micLocked, room.state.camLocked), (false, true));
      expect(room.state.message, 'You can now unmute. Your camera stays locked.');
      await room.toggleCamera();
      expect(room.state.cameraOn, isFalse);
      expect(room.state.message, 'Your camera is locked. An Owner, Host, or Moderator can unlock it.');
      // Unlocked for everyone: the camera too, and they are told.
      room.syncMicLock(_open);
      expect((room.state.micLocked, room.state.camLocked), (false, false));
      expect(room.state.message, 'You can now turn your microphone and camera on.');
    });
  });

  group('a host or moderator', () {
    testWidgets("hears the server's changes to the lock", (tester) async {
      await tester.runAsync(() async => room = _Room(const RoomState(role: 'cohost')));
      room.send({'type': 'mic_lock', 'locked': true, 'allowed': <String>[]});
      expect(room.state.micLockOn, isTrue);
      room.send({'type': 'mic_lock', 'locked': true, 'allowed': ['user_2']});
      expect(room.state.micAllowed, {'user_2'});
      room.send({'type': 'mic_lock', 'locked': false, 'allowed': <String>[]});
      expect(room.state.micLockOn, isFalse);
      expect(room.state.micAllowed, isEmpty);
    });

    Future<void> openSheet(WidgetTester tester, RoomState state, PersonView person) async {
      await tester.runAsync(() async => room = _Room(state));
      final container = ProviderContainer(overrides: [roomControllerProvider.overrideWith((ref, slug) => room)]);
      container.listen(roomControllerProvider('t'), (_, _) {});
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            body: NeoTheme(palette: NeoPalette.dark, child: PersonActionsSheet(slug: 't', person: person)),
          ),
        ),
      ));
      await tester.pump();
    }

    Future<void> closeSheet(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    }

    const grace = PersonView(id: 'user_2#1', name: 'Grace', role: 'attendee');

    testWidgets('allows someone locked to unmute', (tester) async {
      await openSheet(tester, const RoomState(role: 'cohost', micLockOn: true), grace);
      expect(find.text('Lock microphone again'), findsNothing);
      await tester.tap(find.text('Allow to unmute'));
      await tester.pump();
      expect(room.calls, ['allow user_2#1']);
      await closeSheet(tester);
    });

    testWidgets('locks someone allowed again', (tester) async {
      await openSheet(tester, const RoomState(role: 'host', micLockOn: true, micAllowed: {'user_2'}), grace);
      expect(find.text('Allow to unmute'), findsNothing);
      await tester.tap(find.text('Lock microphone again'));
      await tester.pump();
      expect(room.calls, ['relock user_2#1']);
      await closeSheet(tester);
    });

    testWidgets('is offered neither while microphones are not locked, or for a host or moderator', (tester) async {
      await openSheet(tester, const RoomState(role: 'host'), grace);
      expect(find.text('Allow to unmute'), findsNothing);
      expect(find.text('Lock microphone again'), findsNothing);
      await closeSheet(tester);
      await openSheet(tester, const RoomState(role: 'host', micLockOn: true), const PersonView(id: 'user_3#1', name: 'Musa', role: 'cohost'));
      expect(find.text('Allow to unmute'), findsNothing);
      await closeSheet(tester);
    });
  });
}
