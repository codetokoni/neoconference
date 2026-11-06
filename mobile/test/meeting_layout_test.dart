import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/components.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/person_sheets.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// The meeting's layout on the phone: the bars never cover the tiles, every
/// tile's menu is reachable and acts on its own person however the tiles
/// move, and there is always a way back to the grid and to the controls.
///
/// Each test is a bug the app shipped with:
/// - the header and control bar were drawn over the tiles with a fixed gap
///   reserved, so large text (or a caption, or a banner) covered the first
///   row's names and menus;
/// - tiles were not tied to their person: a hold that began on one person
///   opened the menu of whoever slid into that place as the speaker
///   changed;
/// - the grid button did nothing while someone was pinned;
/// - with the controls hidden and a video that takes taps itself (LiveKit's
///   own camera view does), nothing brought them back, Leave included.
void main() {
  const me = PersonView(id: 'me', name: 'Victor', isMe: true, role: 'host');
  const ada = PersonView(id: 'ada#1', name: 'Ada');
  const ben = PersonView(id: 'ben#1', name: 'Ben');
  const cy = PersonView(id: 'cy#1', name: 'Cy');
  const dee = PersonView(id: 'dee#1', name: 'Dee');

  RoomView view(List<PersonView> people, {String? pinnedId}) => RoomView(
        title: 'Weekly prayer meeting',
        people: people,
        link: RoomLinkState.live,
        elapsed: const Duration(minutes: 3),
        canManage: true,
        pinnedId: pinnedId,
      );

  late List<String> opened;
  late int unpinned;

  RoomActions actions() => RoomActions(
        toggleMic: () async {},
        toggleCamera: () async {},
        toggleHand: () async {},
        leave: () async {},
        openPersonMenu: (p) => opened.add(p.id),
        unpin: () => unpinned++,
      );

  setUp(() {
    opened = [];
    unpinned = 0;
  });

  /// The stage with a room the test can change while it is on screen.
  Future<ValueNotifier<RoomView>> pumpStage(
    WidgetTester tester,
    RoomView initial, {
    double textScale = 1,
    Widget? captions,
  }) async {
    final room = ValueNotifier(initial);
    final acts = actions();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
            child: Scaffold(
              body: NeoTheme(
                palette: NeoPalette.dark,
                child: ValueListenableBuilder<RoomView>(
                  valueListenable: room,
                  builder: (_, r, _) => MeetingStage(room: r, actions: acts, captions: captions),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return room;
  }

  Finder menuOf(String name) => find.byTooltip('Options for $name');

  testWidgets('large text: the header has its own space, and first-row menus are tapped, not the header', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    await pumpStage(tester, view([me, ada, ben, cy]), textScale: 1.6);
    await tester.tap(find.byTooltip('Grid view'));
    await tester.pumpAndSettle();

    final title = tester.getRect(find.text('Weekly prayer meeting'));
    final grid = tester.getRect(find.byType(GridView));
    expect(grid.top, greaterThanOrEqualTo(title.bottom), reason: 'tiles start below the header');

    // Ada is in the first row, top right: the corner the header covered.
    await tester.tap(menuOf('Ada'));
    expect(opened, ['ada#1']);

    final leave = tester.getRect(find.text('Leave'));
    expect(grid.bottom, lessThanOrEqualTo(leave.top), reason: 'tiles end above the control bar');
  });

  testWidgets('a three-line caption pushes the tiles up instead of covering their names', (tester) async {
    await pumpStage(
      tester,
      view([me, ada]),
      captions: const SizedBox(height: 76, child: Text('Ada: one\ntwo\nthree')),
    );
    final caption = tester.getRect(find.text('Ada: one\ntwo\nthree'));
    final adaName = tester.getRect(find.text('Ada'));
    expect(adaName.bottom, lessThanOrEqualTo(caption.top));
  });

  testWidgets('a hold that starts on Ada opens Ada, even when the speaker change moves Ben into her place', (tester) async {
    final room = await pumpStage(tester, view([me, ada, ben, cy]));
    await tester.tap(find.byTooltip('Grid view'));
    await tester.pumpAndSettle();

    final gesture = await tester.startGesture(tester.getCenter(find.text('Ada')));
    await tester.pump(const Duration(milliseconds: 100));
    // Ben starts speaking and the order changes: Ada and Ben swap places.
    room.value = view([me, ben, ada, cy]);
    await tester.pump(const Duration(milliseconds: 600));
    await gesture.up();
    await tester.pump();
    expect(opened, ['ada#1']);

    // And a menu tap after the move goes to whoever's button it is.
    await tester.tap(menuOf('Ben'));
    expect(opened, ['ada#1', 'ben#1']);
  });

  testWidgets('someone joining moves the others along without their menus changing hands', (tester) async {
    final room = await pumpStage(tester, view([me, ada, ben]));
    await tester.tap(find.byTooltip('Grid view'));
    await tester.pumpAndSettle();
    room.value = view([me, dee, ada, ben]);
    await tester.pumpAndSettle();
    for (final (name, id) in [('Dee', 'dee#1'), ('Ada', 'ada#1'), ('Ben', 'ben#1')]) {
      await tester.tap(menuOf(name));
      expect(opened.last, id, reason: name);
    }
    expect(menuOf('Victor'), findsNothing, reason: 'your own controls are the bar, not a tile menu');
  });

  testWidgets('pinned: the grid button lets the pin go and shows the grid, every time', (tester) async {
    final room = await pumpStage(tester, view([me, ada, ben], pinnedId: 'ben#1'));
    expect(find.byType(GridView), findsNothing);
    expect(find.text('Pinned · tap to unpin'), findsOneWidget);

    for (var round = 0; round < 3; round++) {
      // The header says what tapping does: the stage shows the speaker view.
      await tester.tap(find.byTooltip('Grid view'));
      expect(unpinned, round + 1);
      room.value = view([me, ada, ben]); // the controller clears the pin
      await tester.pumpAndSettle();
      expect(find.byType(GridView), findsOneWidget, reason: 'round $round');

      // Pin again from the menu (as the sheet would), then back to the grid.
      room.value = view([me, ada, ben], pinnedId: 'ada#1');
      await tester.pumpAndSettle();
      expect(find.byType(GridView), findsNothing);
    }
  });

  testWidgets('pinned: the unpin chip sits above the tile, clear of its menu, and works', (tester) async {
    await pumpStage(tester, view([me, ada, ben], pinnedId: 'ben#1'));
    final chip = tester.getRect(find.text('Pinned · tap to unpin'));
    final benMenu = tester.getRect(menuOf('Ben').first);
    expect(chip.overlaps(benMenu), isFalse);
    await tester.tap(find.text('Pinned · tap to unpin'));
    expect(unpinned, 1);
  });

  testWidgets('hidden controls come back on a tap, even on a video that takes taps itself', (tester) async {
    // LiveKit's view of this phone's own camera is wrapped in a
    // GestureDetector (tap to focus), which won every tap.
    final myCamera = GestureDetector(onTap: () {}, child: const ColoredBox(color: Colors.teal));
    const meOnCamera = PersonView(id: 'me', name: 'Victor', isMe: true);
    await pumpStage(tester, view([PersonView(id: meOnCamera.id, name: meOnCamera.name, isMe: true, video: myCamera)]));

    final teal = find.byWidgetPredicate((w) => w is ColoredBox && w.color == Colors.teal);
    expect(find.text('Leave').hitTestable(), findsOneWidget);
    // Hide them: a tap on the stage beside the video.
    final stage = tester.getRect(teal);
    await tester.tapAt(stage.topLeft - const Offset(4, 4));
    await tester.pumpAndSettle();
    expect(find.text('Leave').hitTestable(), findsNothing);

    for (var round = 0; round < 3; round++) {
      await tester.tap(teal);
      await tester.pumpAndSettle();
      expect(find.text('Leave').hitTestable(), findsOneWidget, reason: 'round $round');
      await tester.tapAt(tester.getRect(teal).topLeft - const Offset(4, 4));
      await tester.pumpAndSettle();
      expect(find.text('Leave').hitTestable(), findsNothing, reason: 'round $round');
    }
  });

  testWidgets('sideways phone: the big tile keeps its height, the strip goes down the side, and every control is reachable', (tester) async {
    tester.view.physicalSize = const Size(844 * 3, 390 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    await pumpStage(tester, view([me, ada, ben, cy, dee]));
    expect(tester.takeException(), isNull, reason: 'no overflow');
    final screen = Offset.zero & const Size(844, 390);
    final leave = tester.getRect(find.text('Leave'));
    expect(screen.contains(leave.center), isTrue);
    expect(find.text('Leave').hitTestable(), findsOneWidget);

    final big = tester.getRect(find.byType(ParticipantTile).first);
    expect(big.height, greaterThan(120), reason: 'the big tile was squeezed to nothing under a 96pt strip');
    for (final name in ['Ada', 'Ben', 'Cy']) {
      final m = menuOf(name);
      if (m.evaluate().isEmpty) continue; // scrolled out of the strip
      expect(screen.contains(tester.getRect(m.first).center), isTrue, reason: name);
    }

    await tester.tap(find.byTooltip('Grid view'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.tap(menuOf('Ada'));
    expect(opened.last, 'ada#1');
  });

  group('the person menu', () {
    setUpAll(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('FlutterWebRTC.Method'),
        (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
      );
    });

    testWidgets('closes when that person leaves, and follows a role change while open', (tester) async {
      late _Room room;
      await tester.runAsync(() async => room = _Room(const RoomState(role: 'host')));
      final container = ProviderContainer(overrides: [roomControllerProvider.overrideWith((ref, slug) => room)]);
      container.listen(roomControllerProvider('t'), (_, _) {});

      var present = <String, PersonView>{'ada#1': const PersonView(id: 'ada#1', name: 'Ada', role: 'attendee')};
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: NeoTheme(
            palette: NeoPalette.dark,
            child: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => neoSheet(
                    context,
                    builder: (_) => LivePersonSheet(
                      slug: 't',
                      id: 'ada#1',
                      lookup: (id, _) => present[id],
                      builder: (fresh) => PersonActionsSheet(slug: 't', person: fresh),
                    ),
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Make Moderator'), findsOneWidget);

      // Made a moderator by another host while the sheet is open.
      present = {'ada#1': const PersonView(id: 'ada#1', name: 'Ada', role: 'cohost')};
      room.bump();
      await tester.pumpAndSettle();
      expect(find.text('Make Moderator'), findsNothing);
      expect(find.text('Demote to Participant'), findsOneWidget);

      // Ada leaves: nothing is offered for someone who is gone.
      present = {};
      room.bump();
      await tester.pumpAndSettle();
      expect(find.text('Ada'), findsNothing);
      expect(find.text('Mute microphone'), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });
  });
}

class _Room extends RoomController {
  _Room(RoomState initial) : super(api: ApiClient(token: () async => null), slug: 't') {
    state = initial;
  }

  /// Something changed in the room (as a join, leave or role change does).
  void bump() => state = state.copyWith();
}
