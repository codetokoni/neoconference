import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/group_models.dart';
import 'package:neoconference/src/groups/group_reports_api.dart';
import 'package:neoconference/src/groups/group_reports_tab.dart';
import 'package:neoconference/src/groups/meeting_report_screen.dart';
import 'package:neoconference/src/groups/my_meetings_screen.dart';
import 'package:neoconference/src/meetings/meeting_share.dart';
import 'package:share_plus/share_plus.dart';

/// Reports on the phone against a fake of the web's routes: the list pages
/// through short pages, a report reads as the web's does, and a spreadsheet
/// arrives as the server named it and goes to the share menu.
void main() {
  late List<http.Request> sent;
  late List<ShareParams> shared;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  Map<String, dynamic> item(String id, String title) => {
        'eventId': id,
        'slug': id,
        'title': title,
        'kind': 'scheduled',
        'date': '2026-10-06T20:00:00.000Z',
        'durationMin': 58,
        'invited': 5,
        'attended': 3,
        'absent': 2,
      };

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/groups/g1/reports') {
          // The first page comes back empty (private calls left out) with
          // more after it.
          return switch (req.url.queryParameters['cursor']) {
            null => json({'items': [], 'nextCursor': 300}),
            '300' => json({'items': [item('e1', 'Cell night')], 'nextCursor': 200}),
            _ => json({'items': [item('e2', 'Prayer')], 'nextCursor': null}),
          };
        }
        if (path == '/api/groups/g1/reports/e1' && req.url.queryParameters['format'] == 'xlsx') {
          return http.Response.bytes([80, 75, 3, 4], 200, headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="report-Cell night-2026-10-06.xlsx"',
          });
        }
        if (path == '/api/groups/g1/reports/e1') {
          return json({
            'report': {
              'eventId': 'e1',
              'slug': 'cell-night',
              'title': 'Cell night',
              'group': {'id': 'g1', 'name': 'Cell Leaders'},
              'kind': 'scheduled',
              'state': 'ended',
              'hosts': ['Ada'],
              'scheduledStart': '2026-10-06T19:00:00.000Z',
              'actualStart': '2026-10-06T19:05:00.000Z',
              'actualEnd': '2026-10-06T20:03:00.000Z',
              'durationMin': 58,
              'participants': [
                {'key': 'u3', 'name': 'Abel', 'email': '', 'status': 'absent', 'declined': true, 'attendedMs': 0, 'entries': 0, 'callAttempts': 2, 'missedCalls': 0},
                {'key': 'u1', 'name': 'Kemi', 'email': '', 'status': 'present', 'declined': false, 'joinedAt': 1791313500000, 'attendedMs': 3480000, 'entries': 2, 'callAttempts': 1, 'missedCalls': 0},
              ],
              'summary': {
                'invited': 5,
                'attended': 3,
                'absent': 2,
                'firstToJoin': 'Kemi',
                'lastToLeave': 'Ada',
                'totalCallAttempts': 7,
                'totalMissedCalls': 2,
                'chatMessages': 4,
                'recordingUrl': null,
                'recorded': false,
                'aiSummary': 'They planned the outreach.',
              },
              'builtAt': 1,
            },
          });
        }
        if (path == '/api/me/meetings') {
          return json({
            'items': [
              {'eventId': 'e1', 'title': 'Cell night', 'groupName': 'Cell Leaders', 'date': '2026-10-06T19:05:00.000Z', 'durationMin': 58, 'attendedMs': 3480000, 'status': 'present', 'declined': false},
            ],
            'nextCursor': null,
          });
        }
        if (path == '/api/me/meetings/e1') {
          return json({
            'meeting': {
              'eventId': 'e1',
              'title': 'Cell night',
              'groupName': 'Cell Leaders',
              'hosts': ['Ada'],
              'date': '2026-10-06T19:05:00.000Z',
              'durationMin': 58,
              'state': 'ended',
              'me': {'name': 'Kemi', 'status': 'present', 'invited': true, 'declined': false, 'joinedAt': 1791313500000, 'leftAt': 1791317000000, 'attendedMs': 3480000, 'entries': 2, 'callAttempts': 1, 'missedCalls': 0},
            },
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

  Widget app(Widget home) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
        ],
        child: MaterialApp(home: home),
      );

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  GroupDetail detail({bool export = true}) => GroupDetail.fromJson({
        'group': {'id': 'g1', 'name': 'Cell Leaders', 'settings': {}},
        'members': [],
        'activity': [],
        'me': {'userId': 'user_me', 'role': export ? 'host' : 'moderator'},
        'capabilities': {'role': export ? 'host' : 'moderator', 'viewReports': true, 'exportReports': export},
      });

  testWidgets('the list keeps going past a short page, then pages on Load more', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(Scaffold(body: GroupReportsTab(detail: detail()))));
    await tester.pumpAndSettle();

    expect(find.text('Cell night'), findsOneWidget);
    expect(find.text('3/5'), findsOneWidget);
    await tester.tap(find.text('Load more'));
    await tester.pumpAndSettle();
    expect(find.text('Prayer'), findsOneWidget);
    expect(find.text('Load more'), findsNothing);
    expect([for (final r in sent) r.url.queryParameters['cursor']], [null, '300', '200']);
  });

  testWidgets('a report reads as the web\'s: numbers, who came first, the summary, present first', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen(groupId: 'g1', eventId: 'e1', canExport: true)));
    await tester.pumpAndSettle();

    expect(find.text('Cell night'), findsOneWidget);
    expect(find.text('Hosted by Ada'), findsOneWidget);
    expect(find.text('58 min'), findsOneWidget);
    expect(find.text('7'), findsOneWidget, reason: 'call attempts');
    expect(find.text('First to join: Kemi'), findsOneWidget);
    expect(find.text('They planned the outreach.'), findsOneWidget);
    expect(find.text('Not recorded.'), findsOneWidget);
    expect(find.text('Declined'), findsOneWidget);
    expect(find.textContaining('58 min · 2 times · 1 rung · 0 missed'), findsOneWidget);
    // Present first, whatever order they came in.
    expect(tester.getTopLeft(find.text('Kemi').last).dy, lessThan(tester.getTopLeft(find.text('Abel')).dy));
  });

  testWidgets('Export XLSX shares the spreadsheet under the name the server gave it', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen(groupId: 'g1', eventId: 'e1', canExport: true)));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Export XLSX'));
    await tester.pumpAndSettle();

    expect(shared.single.fileNameOverrides, ['report-Cell night-2026-10-06.xlsx']);
    expect(await shared.single.files!.single.readAsBytes(), [80, 75, 3, 4]);
  });

  testWidgets('no Export for someone who may only view', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MeetingReportScreen(groupId: 'g1', eventId: 'e1', canExport: false)));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Export XLSX'), findsNothing);
  });

  test('the range export asks for the days as the route takes them', () async {
    sent = [];
    final api = GroupReportsApi(ApiClient(token: () async => 'jwt', http_: server()));
    await api.rangeXlsx('g1', DateTime(2026, 9, 1), DateTime(2026, 10, 6)).catchError((_) => (bytes: <int>[], filename: '', mimeType: ''));
    expect(sent.single.url.path, '/api/groups/g1/reports/export');
    expect(sent.single.url.queryParameters, {'from': '2026-09-01', 'to': '2026-10-06'});
  });

  testWidgets('my reports list my own attendance and open my part in a meeting', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const MyMeetingsScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Cell night'), findsOneWidget);
    expect(find.text('Present'), findsOneWidget);
    expect(find.text('58 min'), findsOneWidget);

    await tester.tap(find.text('Cell night'));
    await tester.pumpAndSettle();
    expect(find.text('Times you joined'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.text('1 · 0 missed'), findsOneWidget);
  });

  test('time attended reads as people say it', () {
    expect(attendedText(0), '—');
    expect(attendedText(20 * 1000), 'under a minute');
    expect(attendedText(42 * 60000), '42 min');
    expect(attendedText(65 * 60000), '1 h 05 min');
  });
}
