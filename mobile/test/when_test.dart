import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/when.dart';

void main() {
  final now = DateTime(2026, 9, 24, 19, 1);

  String ago(Duration d) => neoWhen(now.subtract(d), now: now);
  String ahead(Duration d) => neoWhen(now.add(d), now: now);

  test('under an hour ago is counted in minutes', () {
    // Found on the phone: History showed "0 h ago" against every meeting
    // from earlier the same evening, because anything under an hour
    // rounded to zero hours.
    expect(ago(const Duration(minutes: 35)), '35 min ago');
    expect(ago(const Duration(minutes: 1)), '1 min ago');
    expect(ago(const Duration(minutes: 59)), '59 min ago');
    expect(ago(const Duration(minutes: 35)), isNot(contains('0 h')));
  });

  test('an hour or more ago is counted in hours', () {
    expect(ago(const Duration(minutes: 60)), '1 h ago');
    expect(ago(const Duration(hours: 5)), '5 h ago');
  });

  test('the same moment is now, in either direction', () {
    expect(neoWhen(now, now: now), 'Now');
    expect(ago(const Duration(seconds: 30)), 'Now');
    expect(ahead(const Duration(seconds: 30)), 'Now');
  });

  test('soon is counted in minutes, then hours', () {
    expect(ahead(const Duration(minutes: 18)), 'in 18 min');
    expect(ahead(const Duration(hours: 2, minutes: 48)), 'in 2 h');
  });

  test('yesterday and tomorrow are named', () {
    expect(ahead(const Duration(days: 1, hours: 1)), 'Tomorrow');
    expect(ago(const Duration(days: 1, hours: 3)), 'Yesterday');
  });

  test('further out is counted in days', () {
    expect(ago(const Duration(days: 128)), '128 days ago');
    expect(ahead(const Duration(days: 3)), 'In 3 days');
  });

  test('the greeting follows the hour on the device', () {
    expect(neoGreeting(DateTime(2026, 9, 24, 9)), 'Good morning');
    expect(neoGreeting(DateTime(2026, 9, 24, 13)), 'Good afternoon');
    expect(neoGreeting(DateTime(2026, 9, 24, 19)), 'Good evening');
  });

  test('the clock pads both halves', () {
    expect(neoClock(DateTime(2026, 9, 24, 6, 5)), '06:05');
    expect(neoClock(DateTime(2026, 9, 24, 17, 36)), '17:36');
  });
}
