import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/go_live_sheet.dart';
import 'package:neoconference/src/room/live_stream.dart';
import 'package:neoconference/src/room/plan_limit.dart';

/// Go Live from the phone: the meeting itself streamed to YouTube,
/// Facebook, Twitch or RTMP. The key goes to the server once; the sheet
/// shows where the meeting is going and what each destination says.
void main() {
  Widget host(GoLiveControl control) => MaterialApp(home: Scaffold(body: control));

  testWidgets('a plan without livestreaming is told so, with no dialog', (tester) async {
    await tester.pumpWidget(host(GoLiveControl(
      allowed: false,
      stream: null,
      onStart: (_) async => null,
      onStop: () async => null,
      onRefresh: () {},
    )));
    expect(find.textContaining('Enterprise plan'), findsOneWidget);
    await tester.tap(find.text('Go Live'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('a bad key is refused before anything is sent', (tester) async {
    var sent = 0;
    await tester.pumpWidget(host(GoLiveControl(
      allowed: true,
      stream: null,
      onStart: (_) async {
        sent++;
        return null;
      },
      onStop: () async => null,
      onRefresh: () {},
    )));
    await tester.tap(find.text('Go Live'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start streaming'));
    await tester.pumpAndSettle();
    expect(find.text('Enter the stream key.'), findsOneWidget);
    expect(sent, 0);
  });

  testWidgets('a good key starts the stream with that destination', (tester) async {
    List<StreamDestinationInput>? got;
    await tester.pumpWidget(host(GoLiveControl(
      allowed: true,
      stream: null,
      onStart: (d) async {
        got = d;
        return null;
      },
      onStop: () async => null,
      onRefresh: () {},
    )));
    await tester.tap(find.text('Go Live'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Stream key'), 'abcd-1234-efgh-5678');
    await tester.enterText(find.widgetWithText(TextField, 'Name shown to everyone (optional)'), 'Church channel');
    await tester.tap(find.text('Start streaming'));
    await tester.pumpAndSettle();
    expect(got, hasLength(1));
    expect(got!.single.platform, 'youtube');
    expect(got!.single.key, 'abcd-1234-efgh-5678');
    expect(got!.single.toJson(), {'platform': 'youtube', 'key': 'abcd-1234-efgh-5678', 'label': 'Church channel'});
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('the server\'s refusal is shown in the dialog', (tester) async {
    await tester.pumpWidget(host(GoLiveControl(
      allowed: true,
      stream: null,
      onStart: (_) async => 'The platform refused the stream.',
      onStop: () async => null,
      onRefresh: () {},
    )));
    await tester.tap(find.text('Go Live'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Stream key'), 'abcd-1234-efgh-5678');
    await tester.tap(find.text('Start streaming'));
    await tester.pumpAndSettle();
    expect(find.text('The platform refused the stream.'), findsOneWidget);
    expect(find.byType(AlertDialog), findsOneWidget);
  });

  testWidgets('while live: where it is going, each status, and Stop', (tester) async {
    var stopped = 0;
    await tester.pumpWidget(host(GoLiveControl(
      allowed: true,
      stream: const LiveStreamView(egressId: 'EG_1', destinations: [
        StreamDestinationView(platform: 'youtube', label: 'YouTube', status: 'live'),
        StreamDestinationView(platform: 'facebook', label: 'Facebook', status: 'failed', error: 'bad key'),
      ]),
      onStart: (_) async => null,
      onStop: () async {
        stopped++;
        return null;
      },
      onRefresh: () {},
    )));
    expect(find.text('Live on YouTube and Facebook'), findsOneWidget);
    expect(find.textContaining('Facebook: Failed: bad key'), findsOneWidget);
    await tester.tap(find.text('Stop'));
    await tester.pumpAndSettle();
    expect(stopped, 1);
  });

  test('the stream key is checked as the server checks it', () {
    expect(destinationProblem(const StreamDestinationInput(platform: 'youtube', key: 'rtmp://x/y')), contains('just the stream key'));
    expect(destinationProblem(const StreamDestinationInput(platform: 'rtmp', key: 'https://x')), contains('rtmp://'));
    expect(destinationProblem(const StreamDestinationInput(platform: 'twitch', key: 'live_123_abcdef')), isNull);
  });

  test('the plan flag reaches the room', () {
    final l = MeetingPlanLimits.fromMetadata('{"planLimits":{"meetingMinutes":0,"recording":true,"livestream":true}}')!;
    expect(l.livestream, isTrue);
    expect(MeetingPlanLimits.fromMetadata('{"planLimits":{"recording":true}}')!.livestream, isFalse);
  });

  test('what the server reports becomes a view', () {
    final v = LiveStreamView.fromJson({
      'live': true,
      'egressId': 'EG_9',
      'destinations': [
        {'platform': 'youtube', 'label': 'Sunday service', 'status': 'live'},
      ],
    })!;
    expect(v.liveOn, 'Live on Sunday service');
    expect(LiveStreamView.fromJson({'live': false}), isNull);
  });
}
