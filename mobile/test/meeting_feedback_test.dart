import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/manage/feedback_section.dart';
import 'package:neoconference/src/meetings/room_view.dart';
import 'package:neoconference/src/room/meeting_drop.dart';
import 'package:neoconference/src/room/meeting_feedback.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/room_screen.dart';
import 'package:neoconference/src/screens/meeting_stage.dart';

/// Feedback on a meeting from the app (1.2.14), against a fake of the web's
/// `/api/events/<id>/feedback` (src/lib/meetingFeedback.ts): "Send feedback"
/// in the meeting, "How was the meeting?" after leaving, and the owner's
/// Feedback section on Manage.
const _kinds = [
  {'key': 'sound', 'label': 'Sound'},
  {'key': 'video', 'label': 'Video'},
  {'key': 'joining', 'label': 'Getting in'},
  {'key': 'dropping', 'label': 'Keeps dropping out'},
  {'key': 'other', 'label': 'Something else'},
];

class _Room extends RoomController {
  _Room(RoomState initial, ApiClient api) : super(api: api, slug: 't') {
    state = initial;
  }

  int left = 0;

  @override
  Future<void> leave() async => left++;
}

void main() {
  late List<http.Request> sent;
  late Map<String, dynamic> manage;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/events/t/feedback' || path == '/api/events/sa/feedback') {
          if (req.method == 'POST') return json({'ok': true, 'ticket': 1042});
          return json({
            'meeting': {'name': path.contains('/sa/') ? 'SA Regional Meeting' : 'Test', 'slug': 'sa'},
            'kinds': _kinds,
            'token': null,
            'signedIn': true,
            'manage': ?(path.contains('/sa/') ? manage : null),
          });
        }
        if (path == '/api/events/ev_sa' && req.method == 'PATCH') {
          return json({
            'ok': true,
            'event': {
              'id': 'ev_sa',
              'feedbackContact': {'kcHandle': 'pastormatt', 'email': 'help@church.org'},
            },
            'feedbackReach': {'kcHandleKnown': false, 'ownerKcLinked': true},
          });
        }
        return json({'error': 'not_found'}, 404);
      });

  ApiClient api() => ApiClient(token: () async => 'jwt', http_: server());

  List<Map<String, dynamic>> posts() => [
        for (final r in sent)
          if (r.method == 'POST') (jsonDecode(r.body) as Map).cast<String, dynamic>(),
      ];

  setUp(() {
    sent = [];
    manage = {
      'feedback': [
        {'id': 'f1', 'ts': 1763620000000, 'where': 'room', 'kind': 'sound', 'message': 'The sound keeps cutting out', 'name': 'Ada', 'email': 'ada@example.com', 'device': 'NeoLinguaMeet app, android 1.2.14+5228'},
        {'id': 'f2', 'ts': 1763619000000, 'where': 'after', 'rating': 2, 'message': '', 'name': 'Bola'},
      ],
      'tally': {'stars': [0, 1, 0, 0, 0], 'rated': 1, 'average': 2, 'kinds': {'sound': 1}, 'written': 1},
      'contact': null,
      'contactAllowed': true,
      'reach': {'kcHandleKnown': null, 'ownerKcLinked': null},
    };
  });

  Widget opener(String where) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(api()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => openMeetingFeedback(context, slug: 'sa', where: where),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );

  testWidgets('in the meeting: words and what they are about go to the organiser; nothing is sent empty', (tester) async {
    await tester.pumpWidget(opener('room'));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Send feedback'), findsWidgets);
    expect(find.text('Sound, video, dropping out? Tell the organiser. You stay in the meeting.'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Send feedback'));
    await tester.pump();
    expect(find.text('Write what happened first.'), findsOneWidget);
    expect(posts(), isEmpty);

    await tester.tap(find.widgetWithText(ChoiceChip, 'Sound'));
    await tester.enterText(find.byType(TextField), 'No sound after I rejoined');
    await tester.pump();
    expect(find.text('Write what happened first.'), findsNothing, reason: 'typing clears it');
    await tester.tap(find.widgetWithText(FilledButton, 'Send feedback'));
    await tester.pumpAndSettle();

    expect(posts(), [
      {'where': 'room', 'kind': 'sound', 'message': 'No sound after I rejoined', 'website': ''},
    ]);
    expect(find.byType(MeetingFeedbackSheet), findsNothing, reason: 'the sheet closes');
    expect(find.text('Thank you. The organiser and our support team will see it.'), findsOneWidget);
  });

  testWidgets('after leaving: one tap of the stars sends the rating; words follow without it', (tester) async {
    await tester.pumpWidget(opener('after'));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('How was SA Regional Meeting?'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('star-4')));
    await tester.pumpAndSettle();
    expect(posts(), [
      {'where': 'after', 'rating': 4, 'website': ''},
    ]);
    expect(find.textContaining('Thanks, 4 stars sent.'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('star-5')));
    await tester.pumpAndSettle();
    expect(posts(), hasLength(1), reason: 'one rating each time');

    await tester.enterText(find.byType(TextField), 'Video froze twice');
    await tester.tap(find.widgetWithText(FilledButton, 'Send feedback'));
    await tester.pumpAndSettle();
    expect(posts().last, {'where': 'after', 'message': 'Video froze twice', 'website': ''});
  });

  testWidgets('after leaving: Skip after the stars still says thank you', (tester) async {
    await tester.pumpWidget(opener('after'));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('star-5')));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Skip'));
    await tester.pumpAndSettle();
    expect(find.byType(MeetingFeedbackSheet), findsNothing);
    expect(find.text('Thank you. The organiser and our support team will see it.'), findsOneWidget);
  });

  testWidgets('Send feedback is in the meeting\'s More menu', (tester) async {
    var opened = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: MeetingStage(
          room: const RoomView(
            title: 'Test',
            people: [PersonView(id: 'me', name: 'Me', isMe: true)],
            link: RoomLinkState.live,
            elapsed: Duration(minutes: 1),
          ),
          actions: RoomActions(
            toggleMic: () async {},
            toggleCamera: () async {},
            toggleHand: () async {},
            leave: () async {},
            openFeedback: () => opened++,
          ),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Send feedback'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();
    expect(opened, 1);
  });

  group('leaving the meeting asks how it went', () {
    late _Room room;

    setUpAll(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('FlutterWebRTC.Method'),
        (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
      );
    });

    Future<void> open(WidgetTester tester, RoomState state) async {
      final client = api();
      await tester.runAsync(() async => room = _Room(state, client));
      final container = ProviderContainer(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(client),
          roomControllerProvider.overrideWith((ref, slug) => room),
        ],
      );
      container.listen(roomControllerProvider('t'), (_, _) {});
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const RoomScreen(slug: 't', title: 'Test'))),
                child: const Text('Home'),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Home'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
    }

    Future<void> back(WidgetTester tester) async {
      await tester.state<NavigatorState>(find.byType(Navigator).first).maybePop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
    }

    Future<void> close(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    }

    testWidgets('Leave: the meeting closes, and the stars come up over the screen underneath', (tester) async {
      await open(tester, const RoomState(phase: JoinPhase.connected));
      await back(tester);
      expect(find.text('Leave the meeting?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Leave'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump(const Duration(milliseconds: 500));

      expect(room.left, 1);
      expect(find.byType(RoomScreen), findsNothing);
      expect(find.text('Home'), findsOneWidget);
      expect(find.text('How was Test?'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the meeting ended under them: asked too', (tester) async {
      await open(
        tester,
        const RoomState(
          phase: JoinPhase.failed,
          drop: MeetingDrop(headline: 'The meeting has ended', message: 'The host ended it.', canRejoin: false),
        ),
      );
      await back(tester);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(RoomScreen), findsNothing);
      expect(find.text('How was Test?'), findsOneWidget);
      await close(tester);
    });

    testWidgets('signed out on another device, or never got in: not asked', (tester) async {
      await open(tester, RoomState(phase: JoinPhase.failed, drop: signedOutDrop('You signed in on another device.')));
      await back(tester);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(RoomScreen), findsNothing);
      expect(find.byType(MeetingFeedbackSheet), findsNothing);
      await close(tester);

      await open(tester, const RoomState(phase: JoinPhase.failed, message: 'Could not join'));
      await back(tester);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(RoomScreen), findsNothing);
      expect(find.byType(MeetingFeedbackSheet), findsNothing);
      await close(tester);
    });
  });

  group('the owner\'s Feedback section', () {
    Widget section() => ProviderScope(
          overrides: [
            sessionIdProvider.overrideWithValue('sess_1'),
            apiProvider.overrideWithValue(api()),
          ],
          child: const MaterialApp(
            home: Scaffold(body: SingleChildScrollView(child: FeedbackSection(eventId: 'ev_sa', slug: 'sa'))),
          ),
        );

    testWidgets('the link, the ratings and messages, and a contact saved with what KingsChat can reach', (tester) async {
      tester.view.physicalSize = const Size(1080, 4000);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(section());
      await tester.pumpAndSettle();

      expect(find.textContaining('/feedback/sa'), findsOneWidget);
      expect(find.text('2.0 from 1 rating'), findsOneWidget);
      expect(find.text('1 written message'), findsOneWidget);
      expect(find.text('The sound keeps cutting out'), findsOneWidget);
      expect(find.text('Ada · ada@example.com · NeoLinguaMeet app, android 1.2.14+5228'), findsOneWidget);
      expect(find.bySemanticsLabel('2 of 5 stars'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'KingsChat handle'), '@PastorMatt');
      await tester.enterText(find.widgetWithText(TextField, 'Email'), 'Help@Church.org');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      final patch = sent.singleWhere((r) => r.method == 'PATCH');
      expect(patch.url.path, '/api/events/ev_sa');
      expect(jsonDecode(patch.body), {
        'feedbackContact': {'kcHandle': '@PastorMatt', 'email': 'Help@Church.org'},
      });
      expect(find.text('Saved. New feedback will be sent there too.'), findsOneWidget);
      expect(find.text('@pastormatt'), findsOneWidget, reason: 'what the server kept');
      expect(find.textContaining('Nobody has signed in here with @pastormatt yet'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Remove'), findsOneWidget);
    });

    testWidgets('on the free plan: no contact boxes, a word about paid plans', (tester) async {
      manage['contactAllowed'] = false;
      await tester.pumpWidget(section());
      await tester.pumpAndSettle();
      expect(find.text('On a paid plan, feedback can also go straight to a KingsChat handle or an email.'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'KingsChat handle'), findsNothing);
    });
  });
}
