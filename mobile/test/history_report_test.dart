import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/add_to_group_sheet.dart';
import 'package:neoconference/src/groups/meeting_report_screen.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/meetings/meeting_view.dart';
import 'package:neoconference/src/meetings/meeting_share.dart';
import 'package:neoconference/src/screens/history_screen.dart';
import 'package:share_plus/share_plus.dart';

/// History's report of a meeting outside any group, and making a group of
/// its people, against a fake of the web's routes.
void main() {
  late List<http.Request> sent;
  late List<ShareParams> shared;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  Map<String, dynamic> person(String key, String name, {String? userId, String email = '', bool present = true, bool invited = false}) => {
        'key': key,
        'name': name,
        'userId': ?userId,
        'email': email,
        'invited': invited,
        'status': present ? 'present' : 'absent',
        'declined': false,
        if (present) 'joinedAt': 1791313500000,
        if (present) 'leftAt': 1791315300000,
        'attendedMs': present ? 1800000 : 0,
        'entries': present ? 1 : 0,
        'callAttempts': 0,
        'missedCalls': 0,
      };

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/events/e9/report') {
          return json({
            'report': {
              'eventId': 'e9',
              'slug': 'bible-study',
              'title': 'Bible study',
              'group': null,
              'kind': 'meeting',
              'state': 'ended',
              'hosts': ['Sol'],
              'scheduledStart': null,
              'actualStart': '2026-10-06T19:05:00.000Z',
              'actualEnd': '2026-10-06T19:35:00.000Z',
              'durationMin': 30,
              'participants': [
                person('user_k', 'Kemi', userId: 'user_k'),
                person('user_m', 'Mae', userId: 'user_m', email: 'mae@example.com', invited: true),
                person('name:visitor', 'Visitor'),
                person('kc:nobody', '@nobody', present: false, invited: true),
              ],
              'summary': {
                'invited': 2,
                'attended': 3,
                'absent': 1,
                'firstToJoin': 'Kemi',
                'lastToLeave': 'Mae',
                'totalCallAttempts': 0,
                'totalMissedCalls': 0,
                'chatMessages': 12,
                'recordingUrl': null,
                'recorded': false,
                'aiSummary': null,
              },
            },
            'spreadsheetUrl': '/api/events/e9/attendance',
          });
        }
        if (path == '/api/events/e9/attendance') {
          return http.Response.bytes([80, 75, 3, 4], 200, headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="attendance-bible-study.xlsx"',
          });
        }
        if (path == '/api/groups' && req.method == 'GET') {
          return json({
            'groups': [
              {'id': 'g1', 'name': 'Choir', 'role': 'moderator', 'memberCount': 4, 'settings': {}},
              {'id': 'g2', 'name': 'Readers', 'role': 'participant', 'memberCount': 9, 'settings': {}},
            ],
          });
        }
        if (path == '/api/groups' && req.method == 'POST') {
          final name = (jsonDecode(req.body) as Map)['name'];
          return json({'group': {'id': 'g9', 'name': name, 'settings': {}}});
        }
        if (path == '/api/groups/g9/members' || path == '/api/groups/g1/members') {
          final b = jsonDecode(req.body) as Map;
          return json({
            'ok': true,
            'added': [
              for (final id in (b['userIds'] as List? ?? const []))
                {'userId': id, 'role': 'participant', 'name': id, 'joinedAt': 1},
            ],
            'alreadyMembers': [],
            'notFound': [],
            'pending': [
              for (final h in (b['kcHandles'] as List? ?? const [])) {'key': 'kc:$h', 'kind': 'kc', 'value': h},
              for (final e in (b['emails'] as List? ?? const [])) {'key': 'email:$e', 'kind': 'email', 'value': e},
            ],
            'alreadyPending': [],
          });
        }
        return json({'error': 'not_found'}, 404);
      });

  setUp(() {
    sent = [];
    shared = [];
    final original = shareSheet;
    shareSheet = (p) async => shared.add(p);
    addTearDown(() => shareSheet = original);
  });

  const past = MeetingView(
    title: 'Bible study',
    code: 'bible-study',
    status: MeetingStatus.ended,
    canJoin: true,
    eventId: 'e9',
  );

  Widget app(Widget home) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
          meetingBoardProvider.overrideWith((ref) async => const MeetingBoard(upcoming: [], recent: [past])),
        ],
        child: MaterialApp(home: home),
      );

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Map<String, dynamic> bodyOf(String method, String path) =>
      jsonDecode(sent.lastWhere((r) => r.method == method && r.url.path == path).body) as Map<String, dynamic>;

  testWidgets("tapping a past meeting in History opens its report: time, people, chat, no group's calling", (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const HistoryScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Bible study'));
    await tester.pumpAndSettle();

    expect(find.byType(MeetingReportScreen), findsOneWidget);
    expect(find.text('30 min'), findsOneWidget);
    expect(find.text('12'), findsOneWidget, reason: 'chat messages');
    expect(find.text('CHAT MESSAGES'), findsOneWidget);
    expect(find.text('CALL ATTEMPTS'), findsNothing);
    expect(find.text('Visitor'), findsOneWidget);
    expect(find.textContaining('left'), findsWidgets);
    expect(find.text('Open the meeting again'), findsOneWidget);
    expect(find.text('Create a group'), findsOneWidget);
    expect(find.text('Add to a group'), findsOneWidget);
  });

  testWidgets('Create a group: who came goes in with the group; invitees and typed handles wait to sign up', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen.forMeeting(eventId: 'e9')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create a group'));
    await tester.pumpAndSettle();

    final sheet = find.byType(AddToGroupSheet);
    // The meeting's title is the suggested name; a guest known only by name
    // cannot be added, so is not offered.
    expect(find.descendant(of: sheet, matching: find.widgetWithText(TextField, 'Bible study')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('Visitor')), findsNothing);
    CheckboxListTile tile(String name) =>
        tester.widget(find.descendant(of: sheet, matching: find.widgetWithText(CheckboxListTile, name)));
    expect(tile('Kemi').value, isTrue);
    expect(tile('Mae').value, isTrue);
    expect(tile('@nobody').value, isFalse, reason: "invited but didn't come: not ticked");

    await tester.tap(find.descendant(of: sheet, matching: find.text('@nobody')));
    await tester.enterText(find.widgetWithText(TextField, 'Add by KingsChat handle or email'), '@Extra, x@Y.com');
    await tester.pump();
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Create group'));
    await tester.tap(find.widgetWithText(FilledButton, 'Create group'));
    await tester.pumpAndSettle();

    expect(bodyOf('POST', '/api/groups'), {
      'name': 'Bible study',
      'fromEventId': 'e9',
      'memberUserIds': ['user_k', 'user_m'],
    });
    expect(bodyOf('POST', '/api/groups/g9/members'), {
      'emails': ['x@y.com'],
      'kcHandles': ['nobody', 'extra'],
      'pending': true,
    });
    expect(find.textContaining('Created “Bible study” with 2 people.'), findsOneWidget);
    expect(find.textContaining('3 people without an account yet will join when they sign up'), findsOneWidget);
  });

  testWidgets('Add to a group offers only groups you can add to, and sends who was ticked', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen.forMeeting(eventId: 'e9')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add to a group'));
    await tester.pumpAndSettle();

    expect(find.text('Choir'), findsOneWidget);
    expect(find.text('Readers'), findsNothing, reason: 'only a Member there');
    expect(find.text('A new group'), findsOneWidget);
    await tester.tap(find.text('Choir'));
    await tester.pump();
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Add to group'));
    await tester.tap(find.widgetWithText(FilledButton, 'Add to group'));
    await tester.pumpAndSettle();

    expect(bodyOf('POST', '/api/groups/g1/members'), {
      'userIds': ['user_k', 'user_m'],
      'pending': true,
    });
    expect(find.textContaining('Added 2 people.'), findsOneWidget);
  });

  testWidgets('Export XLSX shares the meeting\'s attendance spreadsheet', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen.forMeeting(eventId: 'e9')));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Export XLSX'));
    await tester.pumpAndSettle();
    expect(shared.single.fileNameOverrides, ['attendance-bible-study.xlsx']);
  });

  test('typed people split into emails and KingsChat handles', () {
    final r = splitPeople(' @Ada, bo@example.com;cy  kc ');
    expect(r.emails, ['bo@example.com']);
    expect(r.handles, ['ada', 'cy', 'kc']);
  });
}
