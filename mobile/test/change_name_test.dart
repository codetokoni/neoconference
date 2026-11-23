import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart' show apiProvider;
import 'package:neoconference/src/room/change_name.dart';

/// "Change my name" in the meeting (room/change_name.dart): the name everyone
/// in meetings sees, as the web's. Asked for in the SA meeting of 23 Nov 2026
/// by someone shown by their KingsChat handle.
void main() {
  group('the rules (the server\'s, src/lib/attendeeName.ts)', () {
    test('a name with a title, any script, digits and . , \' - ( ) & is fine', () {
      for (final ok in ['Pst Nomvula', 'Pst. Nomvula Dube', 'Bro John (Zone 3)', 'Sis. Ọlá-Adé', 'José & Maria', 'Group 12']) {
        expect(meetingNameProblem(ok), isNull, reason: ok);
      }
    });

    test('an email, symbols, one letter, blank or too long are not', () {
      expect(meetingNameProblem('rainy@example.com'), contains('not an email'));
      expect(meetingNameProblem('<script>'), contains('letters and numbers'));
      expect(meetingNameProblem('A'), contains('two letters'));
      expect(meetingNameProblem('   '), contains('Enter the name'));
      expect(meetingNameProblem('x' * 61), contains('under 60'));
    });
  });

  group('the dialog', () {
    late List<Map<String, dynamic>> posts;
    late int status;

    Future<void> open(WidgetTester tester) async {
      posts = [];
      status = 200;
      final api = ApiClient(
        token: () async => 'jwt',
        http_: MockClient((req) async {
          if (req.url.path != '/api/me/display-name' || req.method != 'POST') return http.Response('{}', 404);
          posts.add(jsonDecode(req.body) as Map<String, dynamic>);
          return status == 200
              ? http.Response(jsonEncode({'ok': true, 'name': 'Pst Nomvula'}), 200)
              : http.Response(jsonEncode({'error': 'invalid_name', 'message': 'Enter a name, not an email address.'}), 400);
        }),
      );
      await tester.pumpWidget(ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => openChangeName(context, current: 'rainy', room: 'saregionalmeeting'),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('starts with the current name; a bad one is caught here and not sent', (tester) async {
      await open(tester);
      expect(find.widgetWithText(TextField, 'rainy'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('change-name-field')), 'A');
      await tester.tap(find.byKey(const Key('change-name-save')));
      await tester.pumpAndSettle();
      expect(find.text('Enter at least two letters.'), findsOneWidget);
      expect(posts, isEmpty);
    });

    testWidgets('a refusal shows the server\'s reason; saved, it closes and says so', (tester) async {
      await open(tester);
      await tester.enterText(find.byKey(const Key('change-name-field')), '  Pst Nomvula ');
      status = 400;
      await tester.tap(find.byKey(const Key('change-name-save')));
      await tester.pumpAndSettle();
      expect(find.text('Enter a name, not an email address.'), findsOneWidget);
      status = 200;
      await tester.tap(find.byKey(const Key('change-name-save')));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Everyone now sees you as Pst Nomvula.'), findsOneWidget);
      expect(posts, [
        {'name': 'Pst Nomvula', 'room': 'saregionalmeeting'},
        {'name': 'Pst Nomvula', 'room': 'saregionalmeeting'},
      ]);
    });
  });
}
