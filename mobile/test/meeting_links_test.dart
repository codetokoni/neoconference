import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/meetings/meeting_links.dart';

/// Which neoconference.app links open a meeting in the app.
void main() {
  String? slug(String url) => meetingSlugFromLink(Uri.parse(url));

  test('the meeting page opens that meeting', () {
    expect(slug('https://www.neoconference.app/e/falf'), 'falf');
    expect(slug('https://www.neoconference.app/e/falf/'), 'falf');
  });

  test('the room opens its meeting, named by event when it is given', () {
    expect(slug('https://www.neoconference.app/room/host-control'), 'host-control');
    expect(slug('https://www.neoconference.app/room/rm-123?event=knock-test'), 'knock-test');
  });

  test('pages that are not a meeting to join are left to the browser', () {
    expect(slug('https://www.neoconference.app/e/falf/replay'), isNull);
    expect(slug('https://www.neoconference.app/dashboard'), isNull);
    expect(slug('https://www.neoconference.app/app/auth?__clerk_ticket=x'), isNull);
    expect(slug('https://www.neoconference.app/'), isNull);
  });

  test('only neoconference.app, only https', () {
    expect(slug('https://evil.example/e/falf'), isNull);
    expect(slug('http://www.neoconference.app/e/falf'), isNull);
  });

  test('a slug that is not one is refused', () {
    expect(slug('https://www.neoconference.app/e/..%2F..'), isNull);
    expect(slug('https://www.neoconference.app/room/x?event=bad%20slug'), isNull);
  });

  test('shared links are the meeting page', () {
    expect(meetingShareLink('falf'), 'https://www.neoconference.app/e/falf');
    expect(slug(meetingShareLink('falf')), 'falf');
  });
}
