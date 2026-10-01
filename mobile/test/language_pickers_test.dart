import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/create_meeting_screen.dart';
import 'package:neoconference/src/events/languages.dart';
import 'package:neoconference/src/room/meeting_sheets.dart';

/// A hundred-odd translation languages are found by typing, not scrolling.
void main() {
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
}
