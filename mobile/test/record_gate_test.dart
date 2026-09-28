import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/room_widgets.dart';

/// Recording is on Pro and above. The app offered Record on every plan, and
/// the server took it; the server now refuses, and the host sheet does not
/// offer what would be refused — it says why instead.
///
/// HostRecordControl is the Record cell of the host sheet; the sheet itself
/// needs a live RoomController, whose watchdog timers outlive a widget test.
void main() {
  Future<void> pump(WidgetTester tester, RoomState state, {VoidCallback? onToggle}) =>
      tester.pumpWidget(MaterialApp(
        home: Scaffold(body: HostRecordControl(state: state, onToggle: onToggle ?? () {})),
      ));

  testWidgets('a plan without recording: no Record, and a reason', (tester) async {
    await pump(tester, const RoomState(role: 'host', recordingAllowed: false));
    expect(find.text('Record'), findsNothing);
    expect(find.textContaining('Recording is on the Pro plan and above'), findsOneWidget);
  });

  testWidgets('a plan with recording: Record is offered and starts it', (tester) async {
    var toggled = 0;
    await pump(tester, const RoomState(role: 'host'), onToggle: () => toggled++);
    await tester.tap(find.text('Record'));
    expect(toggled, 1);
    expect(find.textContaining('Recording is on the Pro plan'), findsNothing);
  });

  testWidgets('a recording already running is still shown on any plan', (tester) async {
    await pump(tester, const RoomState(role: 'host', recordingAllowed: false, roomRecording: true));
    expect(find.text('Recording'), findsOneWidget);
  });
}
