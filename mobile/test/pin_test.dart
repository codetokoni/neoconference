import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// Asked for: pin someone in the meeting room so they stay on the big tile.
void main() {
  const me = PersonView(id: 'me', name: 'Me', isMe: true);
  const grace = PersonView(id: 'grace', name: 'Grace');
  const daniel = PersonView(id: 'daniel', name: 'Daniel', speaking: true);
  const sharer = PersonView(id: 'sam', name: 'Sam', sharing: true);

  RoomView view({String? pinnedId, List<PersonView> people = const [me, grace, daniel, sharer]}) => RoomView(
        title: 'T',
        people: people,
        link: RoomLinkState.live,
        elapsed: Duration.zero,
        pinnedId: pinnedId,
      );

  test('without a pin, sharing then speaking wins the big tile', () {
    expect(view().focus?.id, 'sam');
    expect(view(people: const [me, grace, daniel]).focus?.id, 'daniel');
  });

  test('a pinned person stays on the big tile over sharing and speaking', () {
    final v = view(pinnedId: 'grace');
    expect(v.focus?.id, 'grace');
    expect(v.others.map((p) => p.id), isNot(contains('grace')));
  });

  test('yourself can be pinned', () {
    expect(view(pinnedId: 'me').focus?.id, 'me');
  });

  test('a pinned person who left lets the usual rule take over', () {
    final v = view(pinnedId: 'gone');
    expect(v.pinned, isNull);
    expect(v.focus?.id, 'sam');
  });

  testWidgets('the big tile says it is pinned, and tapping that unpins', (tester) async {
    var unpinned = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: MeetingStage(
          room: view(pinnedId: 'grace', people: const [me, grace, daniel]),
          actions: RoomActions(
            toggleMic: () async {},
            toggleCamera: () async {},
            toggleHand: () async {},
            leave: () async {},
            openPersonMenu: (_) {},
            unpin: () => unpinned++,
          ),
        ),
      ),
    ));
    await tester.pump();

    final chip = find.text('Pinned · tap to unpin');
    expect(chip, findsOneWidget);
    await tester.tap(chip);
    expect(unpinned, 1);
  });
}
