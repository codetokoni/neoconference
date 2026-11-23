import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/room/attendance_name.dart';
import 'package:neoconference/src/room/room_controller.dart';

/// The "Full name for attendance" step before joining a meeting: required,
/// pre-filled with the name confirmed last time, checked by the same rules as
/// the server, and saved before the meeting is asked for a token.
void main() {
  // A meeting controller starts LiveKit's device list, which asks WebRTC;
  // without this the test could end before that failed, and fail late.
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  group('the rules (the same as the server\'s)', () {
    test('blank or only spaces: asked for it', () {
      expect(attendanceNameProblem(''), attendanceNameRequired);
      expect(attendanceNameProblem('   '), attendanceNameRequired);
    });
    test('accents, apostrophes, hyphens and a single word are fine', () {
      for (final ok in ['Ngozi Eze', 'Chiamaka Ọkọnkwọ', "Tunde O'Brien", 'Anne-Marie Dubois', 'Adaeze', 'José Núñez']) {
        expect(attendanceNameProblem(ok), isNull, reason: ok);
      }
    });
    test('an email address, digits or one letter are not a name', () {
      expect(attendanceNameProblem('ada@example.com'), 'Enter your name, not an email address.');
      expect(attendanceNameProblem('Ada 2'), isNotNull);
      expect(attendanceNameProblem('A'), attendanceNameRequired);
    });
    test('extra spaces are tidied away', () {
      expect(cleanAttendanceName('  Grace   Okon  '), 'Grace Okon');
    });
  });

  group('the join step', () {
    late List<http.Request> sent;
    late String saved;

    ApiClient api({int postStatus = 200, String? postMessage}) => ApiClient(
          token: () async => 'jwt',
          http_: MockClient((req) async {
            sent.add(req);
            if (req.method == 'GET') {
              return http.Response(jsonEncode({'fullName': saved, 'saved': saved.isNotEmpty}), 200);
            }
            final name = (jsonDecode(req.body) as Map)['fullName'];
            if (postStatus != 200) {
              return http.Response(jsonEncode({'error': 'invalid_name', 'message': postMessage}), postStatus);
            }
            return http.Response(jsonEncode({'ok': true, 'fullName': name, 'saved': true}), 200);
          }),
        );

    Future<List<String>> open(WidgetTester tester, ApiClient client) async {
      final joined = <String>[];
      await tester.pumpWidget(MaterialApp(
        home: NeoTheme(
          palette: NeoPalette.dark,
          child: Scaffold(
            body: AttendanceNameStep(api: client, title: 'Sunday service', onConfirmed: (n) async => joined.add(n)),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      return joined;
    }

    setUp(() {
      sent = [];
      saved = '';
    });

    testWidgets('a returning person sees the name they confirmed last time and joins with it', (tester) async {
      saved = 'Grace Adebayo Okon';
      final joined = await open(tester, api());
      expect(find.text('Grace Adebayo Okon'), findsOneWidget);
      await tester.tap(find.byKey(const Key('attendance-join')));
      await tester.pumpAndSettle();
      expect(joined, ['Grace Adebayo Okon']);
      expect(sent.last.method, 'POST');
      expect(jsonDecode(sent.last.body), {'fullName': 'Grace Adebayo Okon'});
    });

    testWidgets('they can change it before joining', (tester) async {
      saved = 'Grace Okon';
      final joined = await open(tester, api());
      await tester.enterText(find.byKey(const Key('attendance-name')), '  Grace  Adebayo   Okon ');
      await tester.tap(find.byKey(const Key('attendance-join')));
      await tester.pumpAndSettle();
      expect(joined, ['Grace Adebayo Okon']);
    });

    testWidgets('blank: the message under the field, nothing saved, nothing joined', (tester) async {
      final joined = await open(tester, api());
      await tester.tap(find.byKey(const Key('attendance-join')));
      await tester.pumpAndSettle();
      expect(find.text(attendanceNameRequired), findsOneWidget);
      expect(joined, isEmpty);
      expect(sent.where((r) => r.method == 'POST'), isEmpty);
      final field = tester.widget<EditableText>(find.descendant(of: find.byKey(const Key('attendance-name')), matching: find.byType(EditableText)));
      expect(field.focusNode.hasFocus, isTrue, reason: 'the field has the focus');
    });

    testWidgets('a refusal from the server shows under the field and does not join', (tester) async {
      final joined = await open(tester, api(postStatus: 400, postMessage: 'Enter your name, not an email address.'));
      await tester.enterText(find.byKey(const Key('attendance-name')), 'Grace Okon');
      await tester.tap(find.byKey(const Key('attendance-join')));
      await tester.pumpAndSettle();
      expect(find.text('Enter your name, not an email address.'), findsOneWidget);
      expect(joined, isEmpty);
    });
  });

  test('a meeting opens on the name step: nothing joins before it is confirmed', () async {
    final c = RoomController(api: ApiClient(token: () async => null), slug: 't');
    await c.join();
    expect(c.state.phase, JoinPhase.confirmName);
    c.dispose();
  });
}
