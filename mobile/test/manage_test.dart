import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/manage/dashboard_screen.dart';
import 'package:neoconference/src/manage/manage_api.dart';
import 'package:neoconference/src/manage/manage_screen.dart';
import 'package:neoconference/src/meetings/meeting_share.dart';
import 'package:share_plus/share_plus.dart';

/// The phone's Manage page and Dashboard, against a fake of the same
/// routes the web dashboard calls. What matters is what reaches the server:
/// the switch sends the waiting-room op the web sends, a revoke names the
/// handle, and a delete goes nowhere until the address is typed back.
void main() {
  late List<http.Request> sent;
  late bool waitingRoom;

  const key = 'recordings/user_1/testneo/2026-09-27T20-00-00.mp4';

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (req.method == 'GET' && path == '/api/events/testneo') {
          return json({
            'ok': true,
            'event': {
              'id': 'evt_1',
              'slug': 'testneo',
              'name': 'Testneo',
              'state': 'ended',
              'waitingRoomEnabled': waitingRoom,
              'isPermanent': false,
              'endPinSet': false,
              'scheduledAt': '2026-09-27T20:00:00.000Z',
            },
          });
        }
        if (path == '/api/waiting-room') {
          waitingRoom = (jsonDecode(req.body) as Map)['enabled'] as bool;
          return json({'ok': true});
        }
        if (path == '/api/events/evt_1/kc-invites') {
          if (req.method == 'DELETE') return json({'ok': true});
          return json({
            'items': [
              {'handle': 'pastorchris', 'role': 'moderator'},
            ],
          });
        }
        if (path == '/api/recordings') {
          return json({
            'ok': true,
            'recordings': [
              {
                'key': key,
                'size': 5 * 1024 * 1024,
                'lastModified': '2026-09-27T21:00:00.000Z',
                'transcript': {'status': 'done', 'text': 'Can you hear me? Yes. Okay.'},
              },
            ],
          });
        }
        if (path == '/api/events/evt_1/summary') return json({'summary': null});
        if (path == '/api/events/evt_1/invite-kc') {
          return json({'ok': true, 'assigned': true, 'sent': false, 'sendReason': 'recipient_never_signed_in'});
        }
        if (path == '/api/events/delete') return json({'ok': true});
        if (path == '/api/events/mine') return json({'events': []});
        return json({'error': 'not_found'}, 404);
      });

  setUp(() {
    sent = [];
    waitingRoom = false;
  });

  // Tall enough that the whole page builds: its list is lazy.
  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Widget app(Widget home) => ProviderScope(
        overrides: [
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
          eventsProvider.overrideWith((ref) async => [
                const NeoEvent(
                  id: 'evt_1',
                  slug: 'testneo',
                  name: 'Testneo',
                  state: 'live',
                  isPermanent: false,
                  isLocked: false,
                  waitingRoomEnabled: false,
                ),
              ]),
        ],
        child: MaterialApp(home: home),
      );

  testWidgets('the waiting-room switch sends the op the web sends', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();

    expect(find.text('Testneo'), findsWidgets);
    expect(find.text('@pastorchris'), findsOneWidget);
    expect(find.text('Cohost'), findsOneWidget);

    await tester.tap(find.widgetWithText(SwitchListTile, 'Waiting room'));
    await tester.pumpAndSettle();

    final op = sent.lastWhere((r) => r.url.path == '/api/waiting-room');
    expect(jsonDecode(op.body), {'op': 'set', 'slug': 'testneo', 'enabled': true});
    // Reloaded from the server, not assumed.
    expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isTrue);
  });

  testWidgets('revoke names the handle', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Revoke'));
    await tester.pumpAndSettle();

    final revoke = sent.singleWhere((r) => r.method == 'DELETE');
    expect(revoke.url.path, '/api/events/evt_1/kc-invites');
    expect(jsonDecode(revoke.body), {'handle': 'pastorchris'});
  });

  testWidgets('adding a cohost says the KingsChat message did not go', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(TextButton, 'Add'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '@ada');
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final invite = sent.singleWhere((r) => r.url.path == '/api/events/evt_1/invite-kc');
    expect(jsonDecode(invite.body), {'handle': 'ada', 'role': 'moderator', 'sendMessage': true});
    expect(find.textContaining('No KingsChat message was sent'), findsOneWidget);
  });

  testWidgets('Share opens the share menu with the invite', (tester) async {
    final shared = <ShareParams>[];
    final real = shareSheet;
    shareSheet = (p) async => shared.add(p);
    addTearDown(() => shareSheet = real);

    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(OutlinedButton, 'Share').first);
    await tester.pumpAndSettle();

    expect(shared, hasLength(1));
    expect(shared.single.text, contains('Join "Testneo" on NeoConference'));
    expect(shared.single.text, contains('https://www.neoconference.app/e/testneo'));
    expect(shared.single.subject, 'Testneo');
  });

  testWidgets('a transcribed recording can be read', (tester) async {
    // It said "Transcribed" and showed no words: the owner took that for
    // no transcript at all.
    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Read transcript'));
    await tester.pumpAndSettle();
    expect(find.text('Can you hear me? Yes. Okay.'), findsOneWidget);
  });

  testWidgets('delete sends nothing until the address is typed back', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const ManageMeetingScreen(slug: 'testneo')));
    await tester.pumpAndSettle();

    Future<void> tryDelete(String typed) async {
      await tester.tap(find.text('Delete meeting'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), typed);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
    }

    await tryDelete('testne');
    expect(sent.where((r) => r.url.path == '/api/events/delete'), isEmpty);

    await tryDelete('testneo');
    final del = sent.singleWhere((r) => r.url.path == '/api/events/delete');
    expect(jsonDecode(del.body), {'slug': 'testneo', 'confirm': 'testneo', 'mode': 'delete'});
  });

  testWidgets('the dashboard counts meetings, live, recordings and transcripts', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const DashboardScreen()));
    await tester.pumpAndSettle();

    String stat(String label) => tester
        .widgetList<DashboardStat>(find.byType(DashboardStat))
        .singleWhere((s) => s.label == label)
        .value!;
    expect(stat('Meetings'), '1');
    expect(stat('Live now'), '1');
    expect(stat('Recordings'), '1');
    expect(stat('Transcripts'), '1');
    // The recording is labelled with its meeting's name, from its key.
    expect(find.text('Testneo'), findsWidgets);
  });

  test('a recording knows its meeting from its key', () {
    expect(const MeetingRecording(key: key, size: 1).slug, 'testneo');
    expect(const MeetingRecording(key: 'elsewhere.mp4', size: 1).slug, isNull);
  });

  test('an invite says whether the KingsChat message went', () {
    expect(inviteOutcome('ada', 'host', asked: false, sent: false), '@ada is now a host.');
    expect(inviteOutcome('ada', 'moderator', asked: true, sent: true), '@ada is now a cohost, and was told on KingsChat.');
    expect(
      inviteOutcome('ada', 'moderator', asked: true, sent: false, reason: 'recipient_never_signed_in'),
      contains('No KingsChat message was sent'),
    );
  });

  test('refusals read as sentences', () {
    expect(
      manageErrorMessage(const ApiException(status: 403, message: 'forbidden', body: {'error': 'forbidden'})),
      "Only the meeting's owner can change this.",
    );
    expect(
      manageErrorMessage(const ApiException(status: 400, message: 'pin_too_short', body: {'error': 'pin_too_short'})),
      'The PIN needs at least 4 digits.',
    );
    // A 5xx with a known reason is named, not "having trouble".
    expect(
      manageErrorMessage(const ApiException(status: 503, message: 'ai_not_configured', body: {'error': 'ai_not_configured'})),
      'AI summaries are not set up on this server.',
    );
    expect(
      manageErrorMessage(const ApiException(status: 502, message: 'ai_failed', body: {'error': 'ai_failed'})),
      'The AI could not write a summary just now. Try again.',
    );
  });
}
