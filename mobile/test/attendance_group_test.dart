import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/room/attendance_name.dart';

/// "Your church or group" in the app's join step, for a meeting that lists
/// them (src/lib/attendanceGroups.ts): asked once, required, sent with the
/// full name, so the organiser and each group's leader get their people's
/// attendance after the meeting.
void main() {
  late List<http.Request> sent;

  ApiClient api({List<String>? groups, String? group}) => ApiClient(
        token: () async => 'jwt',
        http_: MockClient((req) async {
          sent.add(req);
          if (req.method == 'GET') {
            return http.Response(
              jsonEncode({'fullName': 'Ann Mokoena', 'saved': true, 'groups': ?groups, 'group': ?group}),
              200,
            );
          }
          final b = jsonDecode(req.body) as Map;
          return http.Response(jsonEncode({'ok': true, 'fullName': b['fullName'], 'saved': true, 'group': ?b['group']}), 200);
        }),
      );

  Future<List<String>> open(WidgetTester tester, ApiClient client) async {
    final joined = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: NeoTheme(
        palette: NeoPalette.dark,
        child: Scaffold(
          body: AttendanceNameStep(api: client, title: 'SA Prayer Meeting', slug: 'saregionalmeeting', onConfirmed: (n) async => joined.add(n)),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    return joined;
  }

  setUp(() => sent = []);

  testWidgets('asks with the meeting; a church must be picked; it is sent with the name and the meeting', (tester) async {
    final joined = await open(tester, api(groups: ['Soweto', 'Pretoria']));
    expect(sent.first.url.queryParameters['event'], 'saregionalmeeting');
    expect(find.text('Your church or group *'), findsOneWidget);
    await tester.tap(find.byKey(const Key('attendance-join')));
    await tester.pumpAndSettle();
    expect(find.text('Choose your church or group.'), findsOneWidget);
    expect(joined, isEmpty);
    expect(sent.where((r) => r.method == 'POST'), isEmpty);

    await tester.tap(find.byKey(const Key('attendance-group')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pretoria').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('attendance-join')));
    await tester.pumpAndSettle();
    expect(joined, ['Ann Mokoena']);
    expect(jsonDecode(sent.last.body), {'fullName': 'Ann Mokoena', 'event': 'saregionalmeeting', 'group': 'Pretoria'});
  });

  testWidgets('their last pick is already chosen', (tester) async {
    final joined = await open(tester, api(groups: ['Soweto', 'Pretoria'], group: 'Soweto'));
    await tester.tap(find.byKey(const Key('attendance-join')));
    await tester.pumpAndSettle();
    expect(joined, ['Ann Mokoena']);
    expect(jsonDecode(sent.last.body), {'fullName': 'Ann Mokoena', 'event': 'saregionalmeeting', 'group': 'Soweto'});
  });

  testWidgets('a meeting with no list: not asked, and only the name is sent', (tester) async {
    final joined = await open(tester, api());
    expect(find.text('Your church or group *'), findsNothing);
    await tester.tap(find.byKey(const Key('attendance-join')));
    await tester.pumpAndSettle();
    expect(joined, ['Ann Mokoena']);
    expect(jsonDecode(sent.last.body), {'fullName': 'Ann Mokoena'});
  });
}
