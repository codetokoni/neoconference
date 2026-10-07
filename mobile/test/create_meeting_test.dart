import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/create_meeting_screen.dart';
import 'package:neoconference/src/events/event.dart' show apiProvider;

/// Found on a phone (build 3208): "Create and join" with no name showed the
/// server's `name_required` in the red box. The name field sits at the top
/// of a lazy list; scrolling down to the button disposed it, so the form had
/// nothing left to validate and the empty name went to the server.
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
      child: const MaterialApp(home: CreateMeetingScreen()),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> tapCreate(WidgetTester tester) async {
    final create = find.text('Create and join');
    await tester.scrollUntilVisible(
      create,
      200,
      scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(create);
    await tester.pumpAndSettle();
  }

  testWidgets('an empty name is caught here, in a sentence, and not sent', (tester) async {
    reply = '{"error":"name_required"}';
    await openOnAPhone(tester);

    await tapCreate(tester);

    expect(posts, isEmpty, reason: 'the empty name reached the server');
    expect(find.textContaining('name_required'), findsNothing);
    expect(find.text('Give the meeting a name.'), findsOneWidget);
  });

  testWidgets("the server's refusal is said as a sentence, not its code", (tester) async {
    // A name this phone accepts but the server does not (or an older
    // check here than there): the reply's code still must not be shown.
    reply = '{"error":"name_required"}';
    await openOnAPhone(tester);
    await tester.enterText(find.byType(TextFormField), 'Sunday Service');

    await tapCreate(tester);

    expect(posts.single['name'], 'Sunday Service');
    expect(find.text('Give the meeting a name.'), findsOneWidget);
    expect(find.textContaining('name_required'), findsNothing);
  });

  test('every code the create route answers without a sentence has one', () {
    for (final code in ['name_required', 'invalid_json', 'unauthenticated']) {
      final text = createMeetingErrorText(ApiException(status: 400, message: code, body: {'error': code}));
      expect(text, isNot(code), reason: code);
      expect(text, endsWith('.'), reason: code);
    }
    // A refusal that came with the server's own sentence keeps it.
    const capped = ApiException(
      status: 403,
      message: 'You have reached the Free plan limit of 3 lifetime meetings. Upgrade to create more.',
      body: {'error': 'lifetime_meetings_exhausted'},
    );
    expect(createMeetingErrorText(capped), capped.message);
  });
}
