import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import '../screens/prejoin_screen.dart';
import 'meeting_view.dart';

/// The meeting a neoconference.app link is for, or null when it is not a
/// meeting link this app opens.
///
/// Android hands the app the links the manifest claims (App Links, verified
/// by /.well-known/assetlinks.json): `/room/<room>?event=<slug>` — the room
/// itself, where `event` is the meeting when the LiveKit room name differs
/// — and `/e/<slug>`, the meeting's page. A replay (`/e/<slug>/replay`) is a
/// page, not a meeting to join.
String? meetingSlugFromLink(Uri uri) {
  if (uri.scheme != 'https') return null;
  if (uri.host != 'www.neoconference.app' && uri.host != 'neoconference.app') return null;
  final parts = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (parts.length != 2) return null;
  final slug = switch (parts.first) {
    'room' => uri.queryParameters['event']?.trim().isNotEmpty == true
        ? uri.queryParameters['event']!.trim()
        : parts[1],
    'e' => parts[1],
    _ => null,
  };
  if (slug == null || !RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$').hasMatch(slug)) return null;
  return slug.toLowerCase();
}

/// The link to share for a meeting: its page, which opens straight in this
/// app on a phone that has it and works in any browser that does not.
String meetingShareLink(String slug) => 'https://www.neoconference.app/e/$slug';

/// Meeting links that arrived — at launch or while running — and have not
/// been opened yet. Listened to from app start, so a link that launched
/// the app before anyone was signed in is still waiting after they sign in.
class IncomingMeetingLinks {
  IncomingMeetingLinks._();

  static final IncomingMeetingLinks instance = IncomingMeetingLinks._();

  /// The slug waiting to be opened.
  final pending = ValueNotifier<String?>(null);

  StreamSubscription<Uri>? _sub;
  String? _lastSlug;
  DateTime? _lastAt;

  /// Needs the Flutter binding (main calls ensureInitialized first): the
  /// first build called this before it, the platform channel threw, and a
  /// tapped link opened the app on Home instead of its meeting.
  void start() {
    if (_sub != null) return;
    final links = AppLinks();
    _sub = links.uriLinkStream.listen(_receive, onError: (Object e) => debugPrint('[links] $e'));
    // The link the app was launched with. The stream usually delivers it
    // too; _receive drops the second copy.
    unawaited(links.getInitialLink().then((uri) {
      if (uri != null) _receive(uri);
    }).catchError((Object e) => debugPrint('[links] initial: $e')));
  }

  void _receive(Uri uri) {
    final slug = meetingSlugFromLink(uri);
    if (slug == null) return;
    final now = DateTime.now();
    if (slug == _lastSlug && _lastAt != null && now.difference(_lastAt!) < const Duration(seconds: 5)) {
      return;
    }
    _lastSlug = slug;
    _lastAt = now;
    debugPrint('[links] meeting link for $slug');
    pending.value = slug;
  }

  /// Takes the waiting slug, so it is opened once.
  String? take() {
    final slug = pending.value;
    pending.value = null;
    return slug;
  }
}

/// Opens meeting links while someone is signed in: wraps the signed-in part
/// of the app and pushes the pre-join for each link that arrives.
class MeetingLinkOpener extends StatefulWidget {
  const MeetingLinkOpener({super.key, required this.child});

  final Widget child;

  @override
  State<MeetingLinkOpener> createState() => _MeetingLinkOpenerState();
}

class _MeetingLinkOpenerState extends State<MeetingLinkOpener> {
  final _links = IncomingMeetingLinks.instance;

  @override
  void initState() {
    super.initState();
    _links.pending.addListener(_open);
    // A link that came in before sign-in, or before this was built.
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  @override
  void dispose() {
    _links.pending.removeListener(_open);
    super.dispose();
  }

  void _open() {
    if (!mounted || _links.pending.value == null) return;
    final slug = _links.take()!;
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PreJoinScreen(
          meeting: MeetingView(
            title: slug,
            code: slug,
            status: MeetingStatus.live,
            canJoin: true,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
