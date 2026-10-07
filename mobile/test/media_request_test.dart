import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart' show DataReceivedEvent;
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/room_screen.dart';

/// "Ask to unmute mic" and "Ask to turn on camera", arriving on the phone.
///
/// The server sends the person a LiveKit data packet
/// `{type: 'media_request', kind, to, fromName}` and the web asks them. The
/// app had no case for it, so the request reached the phone and vanished:
/// the host tapped, nothing happened anywhere.
class _Room extends RoomController {
  _Room(RoomState initial) : super(api: ApiClient(token: () async => null), slug: 't') {
    state = initial;
  }

  final calls = <String>[];

  @override
  Future<void> toggleMic() async => calls.add('mic');

  @override
  Future<void> toggleCamera() async => calls.add('camera');

  void send(Map<String, Object?> payload) => receiveData(
        DataReceivedEvent(participant: null, data: utf8.encode(jsonEncode(payload)), topic: null),
      );
}

Map<String, Object?> _ask(String kind, {String? to, String fromName = 'Victor'}) =>
    {'type': 'media_request', 'kind': kind, 'to': ?to, 'fromName': fromName, 'ts': 1};

/// A button in the question, not the meeting's own Unmute behind it.
Finder _inDialog(String label) => find.descendant(of: find.byType(AlertDialog), matching: find.text(label));

void main() {
  late _Room room;

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  group('reading the packet', () {
    test('a request for the microphone or the camera, with who asked', () {
      final mic = MediaRequest.fromPayload(_ask('audio'));
      expect(mic?.video, isFalse);
      expect(mic?.fromName, 'Victor');
      expect(MediaRequest.fromPayload(_ask('video'))?.video, isTrue);
    });

    test('not one for someone else, or of a kind nobody sends', () {
      expect(MediaRequest.fromPayload(_ask('audio', to: 'user_2#1'), myIdentity: 'user_3#1'), isNull);
      expect(MediaRequest.fromPayload(_ask('audio', to: 'user_3#1'), myIdentity: 'user_3#1'), isNotNull);
      expect(MediaRequest.fromPayload(_ask('screen')), isNull);
      expect(MediaRequest.fromPayload({'type': 'timer', 'kind': 'audio'}), isNull);
    });

    test('a blank name still says who', () {
      expect(MediaRequest.fromPayload(_ask('audio', fromName: '  '))?.fromName, 'The host');
    });
  });

  Future<void> open(WidgetTester tester, RoomState state) async {
    // Real clock for the controller's LiveKit Room, and a container kept
    // alive outside the tree: see person_actions_test.dart.
    await tester.runAsync(() async => room = _Room(state));
    final container = ProviderContainer(
      overrides: [roomControllerProvider.overrideWith((ref, slug) => room)],
    );
    container.listen(roomControllerProvider('t'), (_, _) {});
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: RoomScreen(slug: 't', title: 'Test')),
    ));
    await tester.pump();
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  testWidgets('Ask to unmute: the phone asks, and Unmute turns the mic on', (tester) async {
    await open(tester, const RoomState(phase: JoinPhase.connected));
    room.send(_ask('audio'));
    await tester.pumpAndSettle();

    expect(find.text('Unmute your microphone?'), findsOneWidget);
    expect(find.textContaining('Victor is asking you to unmute your microphone'), findsOneWidget);
    expect(room.calls, isEmpty, reason: 'nothing is switched on before an answer');

    await tester.tap(_inDialog('Unmute'));
    await tester.pumpAndSettle();
    expect(room.calls, ['mic']);
    expect(find.text('Unmute your microphone?'), findsNothing);
    await close(tester);
  });

  testWidgets('Ask to turn on camera: Not now leaves it off', (tester) async {
    await open(tester, const RoomState(phase: JoinPhase.connected));
    room.send(_ask('video'));
    await tester.pumpAndSettle();

    expect(find.text('Turn on your camera?'), findsOneWidget);
    await tester.tap(_inDialog('Not now'));
    await tester.pumpAndSettle();
    expect(room.calls, isEmpty);
    expect(find.text('Turn on your camera?'), findsNothing);
    await close(tester);
  });

  testWidgets('a second request while one is open is asked next, not lost or mixed up', (tester) async {
    await open(tester, const RoomState(phase: JoinPhase.connected));
    room.send(_ask('audio'));
    await tester.pumpAndSettle();
    room.send(_ask('video'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);

    await tester.tap(_inDialog('Not now'));
    await tester.pumpAndSettle();
    expect(room.calls, isEmpty, reason: 'Not now on the mic does not turn the camera on');
    expect(find.text('Turn on your camera?'), findsOneWidget);

    await tester.tap(_inDialog('Turn on camera'));
    await tester.pumpAndSettle();
    expect(room.calls, ['camera']);
    await close(tester);
  });

  testWidgets('already unmuted: Unmute does not flip it off', (tester) async {
    await open(tester, const RoomState(phase: JoinPhase.connected, micOn: true));
    room.send(_ask('audio'));
    await tester.pumpAndSettle();
    await tester.tap(_inDialog('Unmute'));
    await tester.pumpAndSettle();
    expect(room.calls, isEmpty);
    await close(tester);
  });
}
