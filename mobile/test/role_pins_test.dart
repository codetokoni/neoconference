import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/components.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// The Owner, Hosts and Moderators are pinned in a row at the top of the
/// meeting for everyone, in that order, from the roles the server puts in
/// LiveKit metadata (role 'host' / 'cohost', owner flag).
void main() {
  const me = PersonView(id: 'me', name: 'Victor', isMe: true, role: 'attendee');
  const ada = PersonView(id: 'ada#1', name: 'Ada', role: 'attendee');
  const ben = PersonView(id: 'ben#1', name: 'Ben', role: 'attendee');
  const olu = PersonView(id: 'olu#1', name: 'Olu', role: 'host', owner: true);
  const hana = PersonView(id: 'hana#1', name: 'Hana', role: 'host');
  const mo = PersonView(id: 'mo#1', name: 'Mo', role: 'cohost');
  const mia = PersonView(id: 'mia#1', name: 'Mia', role: 'cohost');

  RoomView view(List<PersonView> people, {String? pinnedId}) => RoomView(
        title: 'Weekly prayer meeting',
        people: people,
        link: RoomLinkState.live,
        elapsed: const Duration(minutes: 3),
        pinnedId: pinnedId,
      );

  List<String> ids(List<PersonView> people) => [for (final p in people) p.id];

  group('the order', () {
    test('Owner, then Hosts, then Moderators, whatever order they came in', () {
      final room = view([me, mo, ada, hana, mia, olu, ben]);
      expect(ids(room.rolePinned), ['olu#1', 'hana#1', 'mo#1', 'mia#1']);
    });

    test('several moderators keep the order they came in, every time', () {
      const more = [
        PersonView(id: 'm5#1', name: 'M5', role: 'cohost'),
        PersonView(id: 'm1#1', name: 'M1', role: 'cohost'),
        PersonView(id: 'm4#1', name: 'M4', role: 'cohost'),
        PersonView(id: 'm2#1', name: 'M2', role: 'cohost'),
        PersonView(id: 'm3#1', name: 'M3', role: 'cohost'),
      ];
      // Dart's sort is not stable; the order must not depend on it.
      for (var i = 0; i < 20; i++) {
        expect(ids(view([me, ...more, hana]).rolePinned), ['hana#1', 'm5#1', 'm1#1', 'm4#1', 'm2#1', 'm3#1']);
      }
    });

    test('a promotion moves someone in, a demotion moves them out, at once', () {
      expect(ids(view([me, ada, mo]).rolePinned), ['mo#1']);
      const adaModerator = PersonView(id: 'ada#1', name: 'Ada', role: 'cohost');
      expect(ids(view([me, adaModerator, mo]).rolePinned), ['ada#1', 'mo#1']);
      const adaHost = PersonView(id: 'ada#1', name: 'Ada', role: 'host');
      expect(ids(view([me, adaHost, mo]).rolePinned), ['ada#1', 'mo#1']);
      const moDemoted = PersonView(id: 'mo#1', name: 'Mo', role: 'attendee');
      expect(ids(view([me, adaHost, moDemoted]).rolePinned), ['ada#1']);
    });

    test('an owner whose role has not arrived is not pinned as one yet', () {
      const pending = PersonView(id: 'olu#1', name: 'Olu', owner: true);
      expect(view([me, pending]).rolePinned, isEmpty);
    });

    test('the main area has everyone else; the row is not shown when only you would be left there', () {
      final room = view([me, olu, ada]);
      expect(room.showsPinnedRow, isTrue);
      expect(ids(room.mainArea.people), ['me', 'ada#1']);
      // You and the host: the ordinary layout, not the host in a strip
      // above your own face.
      expect(view([me, olu]).showsPinnedRow, isFalse);
      expect(ids(view([me, olu]).mainArea.people), ['me', 'olu#1']);
      // A host alone.
      const hostMe = PersonView(id: 'me', name: 'Victor', isMe: true, role: 'host');
      expect(view([hostMe]).showsPinnedRow, isFalse);
    });

    test('a pinned person who is sharing stays in the main area too: the share is the main view', () {
      const sharing = PersonView(id: 'olu#1', name: 'Olu', role: 'host', owner: true, sharing: true);
      final room = view([me, sharing]);
      expect(room.showsPinnedRow, isTrue);
      expect(room.mainArea.focus?.id, 'olu#1');
    });
  });

  group('on the screen', () {
    late List<String> opened;

    Future<ValueNotifier<RoomView>> pump(WidgetTester tester, RoomView initial, {Size size = const Size(390, 844)}) async {
      tester.view.physicalSize = size * 3;
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      opened = [];
      final room = ValueNotifier(initial);
      final acts = RoomActions(
        toggleMic: () async {},
        toggleCamera: () async {},
        toggleHand: () async {},
        leave: () async {},
        openPersonMenu: (p) => opened.add(p.id),
        unpin: () {},
      );
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: NeoTheme(
            palette: NeoPalette.dark,
            child: ValueListenableBuilder<RoomView>(
              valueListenable: room,
              builder: (_, r, _) => MeetingStage(room: r, actions: acts),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      return room;
    }

    final row = find.byKey(const ValueKey('pinned-row'));
    Finder inRow(Finder f) => find.descendant(of: row, matching: f);
    Finder pinTile(String id) => find.byKey(ValueKey('pin:$id'));
    List<String> rowOrder(WidgetTester tester) {
      final tiles = tester.widgetList<SizedBox>(inRow(find.byWidgetPredicate(
        (w) => w is SizedBox && w.key is ValueKey<String> && (w.key as ValueKey<String>).value.startsWith('pin:'),
      )));
      final placed = [
        for (final t in tiles) ((t.key as ValueKey<String>).value.substring(4), tester.getRect(find.byKey(t.key!)).left),
      ]..sort((a, b) => a.$2.compareTo(b.$2));
      return [for (final p in placed) p.$1];
    }

    testWidgets('the row is above the main area, in order, and the main area has everyone else', (tester) async {
      await pump(tester, view([me, mo, ada, hana, olu, ben]));
      expect(tester.takeException(), isNull);
      expect(row, findsOneWidget);
      expect(rowOrder(tester), ['olu#1', 'hana#1', 'mo#1']);
      // Above the big tile, not beside or over it.
      final big = tester.getRect(find.byKey(const ValueKey('focus:ada#1')));
      expect(tester.getRect(row).bottom, lessThanOrEqualTo(big.top));
      // Nobody from the row is in the filmstrip as well.
      for (final id in ['olu#1', 'hana#1', 'mo#1']) {
        expect(find.byKey(ValueKey(id)), findsNothing, reason: id);
      }
      expect(find.byKey(const ValueKey('ben#1')), findsOneWidget);
    });

    testWidgets('the grid has everyone else too, and the row stays', (tester) async {
      await pump(tester, view([me, mo, ada, hana, olu, ben]));
      await tester.tap(find.byTooltip('Grid view'));
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['olu#1', 'hana#1', 'mo#1']);
      expect(find.byKey(const ValueKey('olu#1')), findsNothing);
      expect(find.byKey(const ValueKey('ada#1')), findsOneWidget);
    });

    testWidgets('a camera that is off: initials, name and role on the tile', (tester) async {
      await pump(tester, view([me, ada, olu, mo]));
      for (final (id, name, role) in [('olu#1', 'Olu', 'Owner'), ('mo#1', 'Mo', 'Moderator')]) {
        final tile = pinTile(id);
        expect(find.descendant(of: tile, matching: find.byType(NeoAvatar)), findsOneWidget, reason: id);
        expect(find.descendant(of: tile, matching: find.text(name[0])), findsOneWidget, reason: id);
        expect(find.descendant(of: tile, matching: find.text(name)), findsOneWidget, reason: id);
        expect(find.descendant(of: tile, matching: find.text(role)), findsOneWidget, reason: id);
      }
    });

    testWidgets('joins, leaves and role changes redraw the row at once', (tester) async {
      final room = await pump(tester, view([me, ada, mo]));
      expect(rowOrder(tester), ['mo#1']);

      // The owner joins late: first in the row.
      room.value = view([me, ada, mo, olu]);
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['olu#1', 'mo#1']);

      // Ada is made a host, then Mo is demoted. (Ben is here so the main
      // area has someone besides this phone.)
      room.value = view([me, const PersonView(id: 'ada#1', name: 'Ada', role: 'host'), mo, olu, ben]);
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['olu#1', 'ada#1', 'mo#1']);
      room.value = view([
        me,
        const PersonView(id: 'ada#1', name: 'Ada', role: 'host'),
        const PersonView(id: 'mo#1', name: 'Mo', role: 'attendee'),
        olu,
        ben,
      ]);
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['olu#1', 'ada#1']);
      expect(find.byKey(const ValueKey('focus:mo#1')), findsOneWidget, reason: 'Mo is back in the main area');

      // Ada and the owner only, with this phone: the ordinary layout.
      room.value = view([me, const PersonView(id: 'ada#1', name: 'Ada', role: 'host'), olu]);
      await tester.pumpAndSettle();
      expect(row, findsNothing);

      // The owner leaves.
      room.value = view([me, const PersonView(id: 'ada#1', name: 'Ada', role: 'host'), ben]);
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['ada#1']);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a reconnect: everyone gone, then back in a new order; the row comes back the same', (tester) async {
      // Wide enough for the whole row: a lazy list builds only what shows.
      final room = await pump(tester, view([me, ada, hana, mo, olu, mia]), size: const Size(600, 900));
      expect(rowOrder(tester), ['olu#1', 'hana#1', 'mo#1', 'mia#1']);
      room.value = view([me]);
      await tester.pumpAndSettle();
      expect(row, findsNothing);
      // LiveKit adds the others back in its own order; within a role the
      // row follows the meeting's order, so the two moderators come back
      // in the order they were added back, behind the owner and host.
      room.value = view([me, mo, mia, olu, ada, hana]);
      await tester.pumpAndSettle();
      expect(rowOrder(tester), ['olu#1', 'hana#1', 'mo#1', 'mia#1']);
    });

    testWidgets('a screen share stays the main view, under the row, and the row shows the sharer\'s face', (tester) async {
      final sharing = PersonView(
        id: 'olu#1',
        name: 'Olu',
        role: 'host',
        owner: true,
        sharing: true,
        video: Container(key: const ValueKey('olu-screen'), color: Colors.blue),
        camera: Container(key: const ValueKey('olu-camera'), color: Colors.green),
      );
      await pump(tester, view([me, ada, sharing, mo]));
      final big = find.byKey(const ValueKey('focus:olu#1'));
      expect(big, findsOneWidget, reason: 'the share is the big tile');
      expect(find.descendant(of: big, matching: find.byKey(const ValueKey('olu-screen'))), findsOneWidget);
      expect(find.descendant(of: pinTile('olu#1'), matching: find.byKey(const ValueKey('olu-camera'))), findsOneWidget);
      expect(find.descendant(of: pinTile('olu#1'), matching: find.byKey(const ValueKey('olu-screen'))), findsNothing);
      expect(tester.getRect(row).bottom, lessThanOrEqualTo(tester.getRect(big).top));
      expect(rowOrder(tester), ['olu#1', 'mo#1']);

      // A speaker change does not move the share or the row.
      room(String? speaking) => view([
            me,
            PersonView(id: 'ada#1', name: 'Ada', role: 'attendee', speaking: speaking == 'ada'),
            sharing,
            mo,
          ]);
      await pump(tester, room('ada'));
      expect(find.byKey(const ValueKey('focus:olu#1')), findsOneWidget);
      expect(rowOrder(tester), ['olu#1', 'mo#1']);
    });

    testWidgets('a speaker change does not move anyone in the row', (tester) async {
      final room = await pump(tester, view([me, ada, olu, mo, ben]));
      for (final speaking in ['mo#1', 'ben#1', 'olu#1', 'ada#1']) {
        room.value = view([
          for (final p in [me, ada, olu, mo, ben])
            PersonView(id: p.id, name: p.name, role: p.role, owner: p.owner, isMe: p.isMe, speaking: p.id == speaking),
        ]);
        await tester.pumpAndSettle();
        expect(rowOrder(tester), ['olu#1', 'mo#1'], reason: speaking);
      }
    });

    testWidgets('pinning someone else on this screen keeps the row; the pin is the big tile', (tester) async {
      await pump(tester, view([me, ada, olu, mo, ben], pinnedId: 'ben#1'));
      expect(find.byKey(const ValueKey('focus:ben#1')), findsOneWidget);
      expect(find.text('Pinned · tap to unpin'), findsOneWidget);
      expect(rowOrder(tester), ['olu#1', 'mo#1']);
    });

    testWidgets('pinning someone from the row shows them large and keeps them in the row', (tester) async {
      await pump(tester, view([me, ada, olu, mo], pinnedId: 'mo#1'));
      expect(find.byKey(const ValueKey('focus:mo#1')), findsOneWidget);
      expect(rowOrder(tester), ['olu#1', 'mo#1']);
    });

    testWidgets('many moderators: the row scrolls sideways and the last one can be reached', (tester) async {
      final mods = [for (var i = 0; i < 8; i++) PersonView(id: 'm$i#1', name: 'Mod $i', role: 'cohost')];
      await pump(tester, view([me, ada, ...mods]));
      expect(tester.takeException(), isNull, reason: 'no overflow');
      expect(pinTile('m7#1'), findsNothing, reason: 'off the right edge at first');
      await tester.dragUntilVisible(pinTile('m7#1'), row, const Offset(-200, 0));
      await tester.pumpAndSettle();
      final last = tester.getRect(pinTile('m7#1'));
      expect(last.right, lessThanOrEqualTo(390));
      // Its menu is for that moderator.
      await tester.tap(find.descendant(of: pinTile('m7#1'), matching: find.byTooltip('Options for Mod 7')));
      expect(opened, ['m7#1']);
    });

    testWidgets('a phone held sideways: a lower row, no overflow, the big tile keeps its height', (tester) async {
      await pump(tester, view([me, ada, olu, mo, ben]), size: const Size(844, 390));
      expect(tester.takeException(), isNull, reason: 'no overflow');
      expect(tester.getRect(pinTile('olu#1')).height, 72);
      expect(tester.getRect(find.byKey(const ValueKey('focus:ada#1'))).height, greaterThan(120));
      expect(find.text('Leave').hitTestable(), findsOneWidget);
    });

    testWidgets('you and the host alone: the ordinary layout, the host large', (tester) async {
      await pump(tester, view([me, olu]));
      expect(row, findsNothing);
      expect(find.byKey(const ValueKey('focus:olu#1')), findsOneWidget);
    });
  });
}
