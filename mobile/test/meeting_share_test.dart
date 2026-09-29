import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/meeting_share.dart';

/// What a shared meeting link says, wherever it is shared from.
void main() {
  test('the meeting, and the link', () {
    expect(
      meetingInviteText('Sunday service', 'sunday-service'),
      'Join "Sunday service" on NeoConference:\nhttps://www.neoconference.app/e/sunday-service',
    );
  });

  test('a scheduled one says when', () {
    expect(
      meetingInviteText('Prayer', 'prayer', when: DateTime(2026, 9, 29, 10, 0)),
      'Join "Prayer" on NeoConference on Tuesday 29 September at 10:00:\n'
      'https://www.neoconference.app/e/prayer',
    );
  });

  test('a meeting with no name still reads', () {
    expect(meetingInviteText('  ', 'abc'), startsWith('Join a meeting on NeoConference:'));
  });
}
