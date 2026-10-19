import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/config.dart';
import 'package:neoconference/src/groups/join_group_screen.dart';
import 'package:neoconference/src/meetings/meeting_links.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// NeoConference became NeoLinguaMeet at neolinguameet.com, and Clerk's
/// sign-in moves with it. The app asks the server where both are
/// (GET /api/app/latest) instead of building them in, so the move needs no
/// further release — and must never follow an address that is not ours.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    Config.resetForTest();
  });

  http.Client server(Map<String, Object?> body, {int status = 200, List<Uri>? asked}) =>
      MockClient((req) async {
        asked?.add(req.url);
        return http.Response(jsonEncode(body), status);
      });

  test('before the server has answered: where 1.2.5 pointed', () {
    expect(Config.site, 'https://www.neoconference.app');
    expect(Config.clerkFrontendApi, 'https://clerk.neoconference.app');
    // The sign-in link stays on the host Android has verified for years.
    expect(Config.deepLinkCallback, 'https://www.neoconference.app/app/auth');
  });

  test('the switch: the app follows the site and Clerk to neolinguameet.com', () async {
    final asked = <Uri>[];
    final changed = await Config.refresh(
      client: server({
        'latestVersion': '1.2.6',
        'site': 'https://neolinguameet.com',
        'clerkFrontendApi': 'https://clerk.neolinguameet.com',
      }, asked: asked),
    );
    expect(changed, isTrue);
    // Asked on the old domain, which keeps serving /api.
    expect(asked.single.toString(), 'https://www.neoconference.app/api/app/latest');
    expect(Config.site, 'https://neolinguameet.com');
    expect(Config.clerkFrontendApi, 'https://clerk.neolinguameet.com');
    // Links the app makes follow.
    expect(meetingShareLink('falf'), 'https://neolinguameet.com/e/falf');
  });

  test('kept for the next start, and for the call-push isolate', () async {
    await Config.adopt({'site': 'https://neolinguameet.com', 'clerkFrontendApi': 'https://clerk.neolinguameet.com'});
    Config.resetForTest();
    expect(Config.site, 'https://www.neoconference.app');
    await Config.load();
    expect(Config.site, 'https://neolinguameet.com');
    expect(Config.clerkFrontendApi, 'https://clerk.neolinguameet.com');
  });

  test('an address that is not ours is never followed: the token and sign-in go there', () async {
    for (final body in [
      {'site': 'https://evil.example', 'clerkFrontendApi': 'https://clerk.evil.example'},
      {'site': 'http://neolinguameet.com', 'clerkFrontendApi': 'http://clerk.neolinguameet.com'},
      {'site': 'https://neolinguameet.com.evil.example'},
      {'site': 42, 'clerkFrontendApi': null},
    ]) {
      expect(await Config.adopt(body), isFalse, reason: '$body');
      expect(Config.site, 'https://www.neoconference.app');
      expect(Config.clerkFrontendApi, 'https://clerk.neoconference.app');
    }
  });

  test('an older server, or none, changes nothing and never throws', () async {
    expect(await Config.refresh(client: server({'latestVersion': '1.2.5'})), isFalse);
    expect(await Config.refresh(client: server({}, status: 503)), isFalse);
    expect(
      await Config.refresh(client: MockClient((_) async => throw Exception('offline'))),
      isFalse,
    );
    expect(Config.site, 'https://www.neoconference.app');
  });

  test('meeting and group links open in the app on either domain', () {
    for (final host in ['www.neoconference.app', 'neoconference.app', 'neolinguameet.com', 'www.neolinguameet.com']) {
      expect(meetingSlugFromLink(Uri.parse('https://$host/e/falf')), 'falf', reason: host);
      expect(meetingSlugFromLink(Uri.parse('https://$host/room/rm-1?event=knock-test')), 'knock-test', reason: host);
      expect(groupInviteTokenFromLink(Uri.parse('https://$host/groups/join/abcdefgh12345678')), 'abcdefgh12345678', reason: host);
    }
    expect(meetingSlugFromLink(Uri.parse('https://neolinguameet.com.evil.example/e/falf')), isNull);
    expect(groupInviteTokenFromLink(Uri.parse('https://evil.example/groups/join/abcdefgh12345678')), isNull);
  });
}
