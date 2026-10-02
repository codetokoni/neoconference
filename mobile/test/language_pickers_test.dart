import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/create_meeting_screen.dart';
import 'package:neoconference/src/events/event.dart' show apiProvider;
import 'package:neoconference/src/events/languages.dart';
import 'package:neoconference/src/home/live_translation_bar.dart';
import 'package:neoconference/src/room/meeting_sheets.dart';
import 'package:neoconference/src/screens/schedule_screen.dart';

/// A hundred-odd translation languages are found by typing, not scrolling.
void main() {
  voiceMarksTests();

  testWidgets('the room picker finds a language by its own name and picks it', (tester) async {
    String? picked = 'unset';
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TranslationLanguageList(selected: null, onPick: (c) => picked = c),
      ),
    ));

    expect(find.text('Off'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'kiswa');
    await tester.pumpAndSettle();

    // Off is hidden while searching; only the match is left.
    expect(find.text('Off'), findsNothing);
    expect(find.byType(RadioListTile<String?>), findsOneWidget);
    await tester.tap(find.text('Swahili'));
    expect(picked, 'sw');

    await tester.enterText(find.byType(TextField), 'zzzz');
    await tester.pumpAndSettle();
    expect(find.textContaining('No language matches'), findsOneWidget);
  });

  testWidgets('a new meeting can take any language from the full list', (tester) async {
    Set<String>? result;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async {
                result = await showModalBottomSheet<Set<String>>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => const LanguageChecklistSheet(initial: {'en'}),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Languages (1 chosen)'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'hausa');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Hausa').first);
    await tester.pumpAndSettle();
    expect(find.text('Languages (2 chosen)'), findsOneWidget);

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(result, {'en', 'ha'});
    expect(languageFor('ha')?.label, 'Hausa');
  });

  // Found on the phone (build 3181): the how-to's "more" was a plain label,
  // so tapping it did nothing, and Schedule could never get past eight
  // languages. Both through the real screens, not the sheets alone.

  testWidgets("the how-to's more opens every language, searchable", (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: LiveTranslationHowTo())));
    final more = find.text('${translationLanguages.length - meetingLanguages.length} more');
    expect(more, findsOneWidget);
    await tester.tap(more);
    await tester.pumpAndSettle();

    expect(find.byType(AllLanguagesSheet), findsOneWidget);
    expect(find.text('${translationLanguages.length} languages'), findsOneWidget);
    await tester.enterText(
      find.descendant(of: find.byType(AllLanguagesSheet), matching: find.byType(TextField)),
      'igbo',
    );
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: find.byType(AllLanguagesSheet), matching: find.byType(ListTile)),
      findsOneWidget,
    );
  });

  testWidgets('Schedule sends a language picked from the full list', (tester) async {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final posts = <Map<String, dynamic>>[];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiProvider.overrideWithValue(ApiClient(
          token: () async => 'jwt',
          http_: MockClient((req) async {
            if (req.method == 'POST') posts.add(jsonDecode(req.body) as Map<String, dynamic>);
            return http.Response('{"error":"stop_here"}', 400);
          }),
        )),
      ],
      child: const MaterialApp(home: ScheduleScreen()),
    ));
    await tester.pumpAndSettle();

    final more = find.text('More languages (${translationLanguages.length})');
    await tester.ensureVisible(more);
    await tester.pumpAndSettle();
    await tester.tap(more);
    await tester.pumpAndSettle();

    await tester.enterText(
      find.descendant(of: find.byType(LanguageChecklistSheet), matching: find.byType(TextField)),
      'swahili',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Swahili').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();

    // Back on the screen, the pick shows as a chip of its own.
    expect(find.widgetWithText(FilterChip, 'Swahili'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'Language check');
    final submit = find.text('Schedule meeting');
    await tester.ensureVisible(submit);
    await tester.pumpAndSettle();
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(posts, isNotEmpty);
    expect(posts.last['languages'], contains('sw'));
  });
}

/// The room picker says which languages this phone can read aloud.
void voiceMarksTests() {
  testWidgets('voice or text only, and how many', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TranslationLanguageList(selected: null, onPick: (_) {}, speakable: const {'es', 'sw'}),
      ),
    ));
    expect(find.text('This phone can read 2 of ${translationLanguages.length} aloud. The others show as text.'),
        findsOneWidget);
    await tester.enterText(find.byType(TextField), 'swahili');
    await tester.pumpAndSettle();
    expect(find.text('Kiswahili · voice'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'igbo');
    await tester.pumpAndSettle();
    expect(find.text('Igbo · text only'), findsOneWidget);
  });
}
