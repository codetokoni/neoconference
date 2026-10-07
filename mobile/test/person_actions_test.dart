import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/person_sheets.dart';
import 'package:neoconference/src/room/room_controller.dart';

/// What holding someone's tile offers, by the viewer's role.
///
/// The server lets a moderator (cohost) mute, turn off a camera, ask to
/// unmute and mute everyone (participant:mute, participant:muteAll), but
/// not change roles or remove (role:grant, participant:kick). The sheet
/// offered a moderator nothing at all; the web offered the mute actions.
class _Room extends RoomController {
  _Room(RoomState initial) : super(api: ApiClient(token: () async => null), slug: 't') {
    state = initial;
  }

  final calls = <String>[];

  @override
  Future<void> moderate(String identity, String action) async => calls.add('$action $identity');
}

const _grace = PersonView(id: 'user_2#1', name: 'Grace', role: 'attendee');

const _muteActions = ['Mute microphone', 'Turn off camera', 'Ask to unmute mic', 'Ask to turn on camera', 'Mute everyone else'];
const _hostActions = ['Make Moderator', 'Remove from room'];

void main() {
  late _Room room;

  setUpAll(() {
    // WebRTC's native plugin does not exist in tests, and the LiveKit Room
    // the controller makes lists devices through it.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  Future<void> open(WidgetTester tester, RoomState state) async {
    // Built on the real clock: the controller makes a LiveKit Room, whose
    // periodic cleanup timer is never cancelled and would fail the test's
    // no-pending-timers check under the fake one.
    await tester.runAsync(() async => room = _Room(state));
    // Held outside the widget tree and kept alive: disposing the controller
    // disconnects a LiveKit room that never connected, which times out.
    final container = ProviderContainer(
      overrides: [roomControllerProvider.overrideWith((ref, slug) => room)],
    );
    container.listen(roomControllerProvider('t'), (_, _) {});
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Scaffold(
          body: NeoTheme(
            palette: NeoPalette.dark,
            child: const PersonActionsSheet(slug: 't', person: _grace),
          ),
        ),
      ),
    ));
    await tester.pump();
  }

  /// Unmounts the sheet; the controller stays alive in its container.
  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  testWidgets('a moderator can mute and ask, but not change roles or remove', (tester) async {
    await open(tester, const RoomState(role: 'cohost'));
    for (final a in _muteActions) {
      expect(find.text(a), findsOneWidget, reason: a);
    }
    for (final a in [..._hostActions, 'Make Host', 'Demote to Participant']) {
      expect(find.text(a), findsNothing, reason: a);
    }
    await close(tester);
  });

  testWidgets("a moderator's Mute microphone reaches the server", (tester) async {
    await open(tester, const RoomState(role: 'cohost'));
    await tester.tap(find.text('Mute microphone'));
    await tester.pump();
    expect(room.calls, ['muteAudio user_2#1']);
    await close(tester);
  });

  testWidgets('a host gets everything but Make Host', (tester) async {
    await open(tester, const RoomState(role: 'host'));
    for (final a in [..._muteActions, ..._hostActions]) {
      expect(find.text(a), findsOneWidget, reason: a);
    }
    expect(find.text('Make Host'), findsNothing);
    await close(tester);
  });

  testWidgets('an attendee only gets Pin', (tester) async {
    await open(tester, const RoomState(role: 'attendee'));
    expect(find.text('Pin to the big screen'), findsOneWidget);
    for (final a in [..._muteActions, ..._hostActions]) {
      expect(find.text(a), findsNothing, reason: a);
    }
    await close(tester);
  });
}
