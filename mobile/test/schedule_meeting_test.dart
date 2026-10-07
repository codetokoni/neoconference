import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart' show apiProvider;
import 'package:neoconference/src/screens/schedule_screen.dart';

/// The same fault Create had (build 3208), on Schedule: the name field sits
/// at the top of a lazy list, scrolling down to "Schedule meeting" disposes
/// it, and the form, with nothing left to validate, let the empty name go to
/// the server, whose `name_required` then showed in the red box.
void main() {
  late List<Map<String, dynamic>> posts;
  late String reply;

  Future<void> openOnAPhone(WidgetTester tester) async {
    // A phone's screen, so the button is below the fold as it was there.
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    posts = [];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiProvider.overrideWithValue(ApiClient(
          token: () async => 'jwt',
          http_: MockClient((req) async {
            if (req.method == 'POST') posts.add(jsonDecode(req.body) as Map<String, dynamic>);
            return http.Response(reply, 400);
          }),
        )),
      ],
      child: const MaterialApp(home: ScheduleScreen()),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> tapSchedule(WidgetTester tester) async {
    final schedule = find.text('Schedule meeting');
    await tester.scrollUntilVisible(
      schedule,
      200,
      scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(schedule);
    await tester.pumpAndSettle();
  }

  testWidgets('an empty name is caught here, in a sentence, and not sent', (tester) async {
    reply = '{"error":"name_required"}';
    await openOnAPhone(tester);

    await tapSchedule(tester);

    expect(posts, isEmpty, reason: 'the empty name reached the server');
    expect(find.textContaining('name_required'), findsNothing);
    expect(find.text('Give the meeting a name.'), findsOneWidget);
  });

  testWidgets("the server's refusal is said as a sentence, not its code", (tester) async {
    // A name this phone accepts but the server does not: the reply's code
    // still must not be shown.
    reply = '{"error":"name_required"}';
    await openOnAPhone(tester);
    await tester.enterText(find.byType(TextFormField), 'Sunday Service');

    await tapSchedule(tester);

    expect(posts.single['name'], 'Sunday Service');
    expect(find.text('Give the meeting a name.'), findsOneWidget);
    expect(find.textContaining('name_required'), findsNothing);
  });
}
