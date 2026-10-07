import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import 'group_join.dart';
import 'presence_heartbeat.dart';

/// A group meeting calling this person: an unread `ring` in their
/// notifications (src/lib/ringEngine.ts), until it expires 45 s after it
/// was sent.
@immutable
class IncomingRing {
  const IncomingRing({
    required this.ringId,
    required this.eventSlug,
    required this.expiresAt,
    this.groupName = '',
    this.meetingTitle = '',
    this.caller = '',
    this.notificationId,
  });

  final String ringId;
  final String eventSlug;
  final DateTime expiresAt;
  final String groupName;
  final String meetingTitle;
  final String caller;

  /// The bell entry it came as, marked read once answered or declined.
  final String? notificationId;

  bool liveAt(DateTime now) => expiresAt.isAfter(now);

  /// A notification (or push) that is a ring still ringing, or null.
  ///
  /// A push's values all arrive as strings (FCM data), so the expiry may
  /// be "1800000000000" as well as a number.
  static IncomingRing? from(Map<String, dynamic> j, DateTime now) {
    if (j['type'] != 'ring' || j['read'] == true || j['read'] == 'true') return null;
    final ringId = j['ringId'];
    final slug = j['eventSlug'];
    final raw = j['expiresAt'];
    final expires = raw is num ? raw.toInt() : (raw is String ? int.tryParse(raw) : null);
    if (ringId is! String || slug is! String || expires == null) return null;
    final ring = IncomingRing(
      ringId: ringId,
      eventSlug: slug,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(expires),
      groupName: j['groupName'] as String? ?? '',
      meetingTitle: (j['meetingTitle'] ?? j['title']) as String? ?? '',
      caller: j['caller'] as String? ?? '',
      notificationId: j['id'] as String?,
    );
    return ring.liveAt(now) ? ring : null;
  }
}

/// The phone's ringtone and vibration (IncomingRinger.kt). Replaced in
/// tests, which have no platform side.
class CallRinger {
  static const _channel = MethodChannel('app.neoconference/ring');

  static Future<void> Function() start = () => _call('start');
  static Future<void> Function() stop = () => _call('stop');

  /// Lets the incoming-call screen show over the lock screen, and only it:
  /// on while it is up, off when it goes.
  static Future<void> Function(bool on) overLock = (on) => _call('showOverLock', {'on': on});

  /// Whether a call can take over the screen; false where the phone has
  /// switched that off for this app, and it arrives as a banner instead.
  /// True when it can't tell (nothing to ask the person to change).
  static Future<bool> Function() canFullScreen = () => _ask('canFullScreen');

  /// Opens the phone's switch for it; false if no settings page opened.
  static Future<bool> Function() openFullScreenSettings = () => _ask('openFullScreenSettings');

  static Future<bool> _ask(String method) async {
    try {
      return await _channel.invokeMethod<bool>(method) ?? true;
    } catch (e) {
      debugPrint('[ring] $method: $e');
      return method == 'canFullScreen';
    }
  }

  static Future<void> _call(String method, [Object? args]) async {
    try {
      await _channel.invokeMethod<void>(method, args);
    } catch (e) {
      debugPrint('[ring] $method: $e');
    }
  }
}

/// Something from outside the watcher's own look at the list.
sealed class IncomingEvent {
  const IncomingEvent();
}

/// A ring arrived by push, or its notification was tapped — or Answer was
/// pressed on it ([answerNow]), which goes straight in.
class RingArrived extends IncomingEvent {
  const RingArrived(this.ring, {this.answerNow = false});
  final IncomingRing ring;
  final bool answerNow;
}

/// Another notification was tapped: a reminder, an invite, a mention.
/// Opens the group when it is known, else the meeting.
class NoticeTapped extends IncomingEvent {
  const NoticeTapped({required this.url, this.groupId});
  final String url;
  final String? groupId;
}

/// Where pushes and notification taps reach the signed-in app. One that
/// arrives before anything listens (the app launched from a notification)
/// is kept until the watcher takes it.
class IncomingCalls {
  IncomingCalls._();

  static final instance = IncomingCalls._();

  final _events = StreamController<IncomingEvent>.broadcast();
  IncomingEvent? _pending;

  Stream<IncomingEvent> get events => _events.stream;

  void add(IncomingEvent event) {
    if (_events.hasListener) {
      _events.add(event);
    } else {
      _pending = event;
    }
  }

  IncomingEvent? takePending() {
    final e = _pending;
    _pending = null;
    return e;
  }

  /// Told when the in-app call screen takes over a ring, so its
  /// notification (still sounding the ringtone) can be taken down.
  void Function(IncomingRing ring)? onScreenShown;
}

/// The meeting a notification's link points at: `/room/<room>?event=<slug>`
/// or `/<slug>`; null for any other page.
String? meetingSlugFromPath(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return null;
  final parts = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (parts.length == 2 && parts[0] == 'room') {
    final event = uri.queryParameters['event']?.trim();
    return event != null && event.isNotEmpty ? event : parts[1];
  }
  if (parts.length == 1 && RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$').hasMatch(parts[0])) return parts[0];
  return null;
}

/// The group a notification's link points at: `/dashboard/groups/<id>`.
String? groupIdFromPath(String url) {
  final parts = (Uri.tryParse(url)?.pathSegments ?? const <String>[]).where((s) => s.isNotEmpty).toList();
  return parts.length >= 3 && parts[0] == 'dashboard' && parts[1] == 'groups' ? parts[2] : null;
}

/// Answering or declining, as the web's IncomingCall does: tell the
/// server, then mark the bell entry read.
class RingResponder {
  const RingResponder(this.api);
  final ApiClient api;

  Future<void> respond(IncomingRing ring, {required bool answer}) async {
    try {
      await api.post('/api/events/${Uri.encodeComponent(ring.eventSlug)}/call-response', {
        'action': answer ? 'answer' : 'decline',
        'ringId': ring.ringId,
      });
    } catch (e) {
      // Answering still goes in; declining just closes.
      debugPrint('[ring] respond: $e');
    }
    final id = ring.notificationId;
    if (id != null) {
      unawaited(api.patch('/api/me/notifications', {
        'ids': [id],
      }).then((_) {}, onError: (Object e) => debugPrint('[ring] mark read: $e')));
    }
  }
}

/// Watches for a group meeting calling, while the app is open, and shows
/// the incoming-call screen for it.
///
/// It reads the same list the web's bell reads (`/api/me/notifications`):
/// at once, whenever the app comes back to the front, and every
/// [every] while it is in front. A ring for the meeting this phone is
/// already in is not shown.
class IncomingCallWatcher extends ConsumerStatefulWidget {
  const IncomingCallWatcher({super.key, required this.child});

  final Widget child;

  /// How often the list is read while the app is open. A ring lasts 45 s.
  static Duration every = const Duration(seconds: 10);

  /// Called once someone is signed in, with their API client: the app
  /// registers for pushes here (CallPush). Unset in tests.
  static void Function(ApiClient api)? onSignedIn;

  /// Opens the group a notification was about. Set by main.dart, which can
  /// see the group screens without this file importing them.
  static void Function(BuildContext context, String groupId)? openGroup;

  @override
  ConsumerState<IncomingCallWatcher> createState() => _IncomingCallWatcherState();
}

class _IncomingCallWatcherState extends ConsumerState<IncomingCallWatcher> with WidgetsBindingObserver {
  Timer? _timer;
  bool _checking = false;

  /// Rings already shown, answered or declined: each is shown once.
  final _seen = <String>{};
  IncomingRing? _showing;
  StreamSubscription<IncomingEvent>? _events;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _events = IncomingCalls.instance.events.listen(_onEvent);
    IncomingCallWatcher.onSignedIn?.call(ref.read(apiProvider));
    _resume();
    // Launched by tapping a notification: it is waiting.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final pending = IncomingCalls.instance.takePending();
      if (pending != null) _onEvent(pending);
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _events?.cancel();
    super.dispose();
  }

  Future<void> _onEvent(IncomingEvent event) async {
    if (!mounted) return;
    switch (event) {
      case RingArrived(:final ring, :final answerNow):
        if (!ring.liveAt(DateTime.now()) || ring.eventSlug == MeetingHeartbeat.instance.current.value) return;
        if (answerNow) {
          // Answer pressed on the notification: straight in, no second ask.
          _seen.add(ring.ringId);
          if (_showing?.ringId == ring.ringId) return; // the screen answers it
          await RingResponder(ref.read(apiProvider)).respond(ring, answer: true);
          if (mounted) await _enter(ring);
          return;
        }
        if (_seen.contains(ring.ringId) || _showing != null) return;
        _seen.add(ring.ringId);
        await _show(ring);
      case NoticeTapped(:final url, :final groupId):
        final group = groupId ?? groupIdFromPath(url);
        final open = IncomingCallWatcher.openGroup;
        if (group != null && open != null) {
          open(context, group);
          return;
        }
        final slug = meetingSlugFromPath(url);
        if (slug != null) await joinGroupMeeting(context, slug: slug, title: slug);
    }
  }

  Future<void> _enter(IncomingRing ring) => joinGroupMeeting(
        context,
        slug: ring.eventSlug,
        title: ring.meetingTitle.isEmpty ? ring.eventSlug : ring.meetingTitle,
        straightIn: true,
      );

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _resume();
    } else if (state == AppLifecycleState.paused) {
      _timer?.cancel();
      _timer = null;
    }
  }

  void _resume() {
    _timer?.cancel();
    _timer = Timer.periodic(IncomingCallWatcher.every, (_) => _check());
    _check();
  }

  Future<void> _check() async {
    if (_checking || _showing != null || ref.read(sessionIdProvider) == null) return;
    _checking = true;
    try {
      final body = await ref.read(apiProvider).get('/api/me/notifications');
      final items = (body is Map ? body['items'] : null) as List? ?? const [];
      final now = DateTime.now();
      final here = MeetingHeartbeat.instance.current.value;
      for (final item in items.whereType<Map<String, dynamic>>()) {
        final ring = IncomingRing.from(item, now);
        if (ring == null || _seen.contains(ring.ringId) || ring.eventSlug == here) continue;
        _seen.add(ring.ringId);
        if (mounted) await _show(ring);
        break;
      }
    } catch (e) {
      debugPrint('[ring] check: $e');
    } finally {
      _checking = false;
    }
  }

  Future<void> _show(IncomingRing ring) async {
    _showing = ring;
    final answered = await Navigator.of(context).push<bool>(
      PageRouteBuilder(
        opaque: true,
        fullscreenDialog: true,
        pageBuilder: (_, _, _) => IncomingCallScreen(ring: ring),
        transitionsBuilder: (_, animation, _, child) => FadeTransition(opacity: animation, child: child),
      ),
    );
    _showing = null;
    if (answered == true && mounted) await _enter(ring);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// The whole screen while a group meeting calls: who, from which group,
/// into which meeting, with Answer and Decline. Rings until answered,
/// declined or expired. Pops true when answered.
class IncomingCallScreen extends ConsumerStatefulWidget {
  const IncomingCallScreen({super.key, required this.ring});

  final IncomingRing ring;

  @override
  ConsumerState<IncomingCallScreen> createState() => _IncomingCallScreenState();
}

class _IncomingCallScreenState extends ConsumerState<IncomingCallScreen> {
  Timer? _expiry;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // This screen rings from here on; a notification for the same ring
    // (still sounding) is taken down.
    IncomingCalls.instance.onScreenShown?.call(widget.ring);
    unawaited(CallRinger.overLock(true));
    unawaited(CallRinger.start());
    final left = widget.ring.expiresAt.difference(DateTime.now());
    _expiry = Timer(left.isNegative ? Duration.zero : left, () {
      if (mounted && !_busy) Navigator.of(context).pop(false);
    });
  }

  @override
  void dispose() {
    _expiry?.cancel();
    unawaited(CallRinger.stop());
    unawaited(CallRinger.overLock(false));
    super.dispose();
  }

  Future<void> _respond(bool answer) async {
    if (_busy) return;
    setState(() => _busy = true);
    _expiry?.cancel();
    unawaited(CallRinger.stop());
    await RingResponder(ref.read(apiProvider)).respond(widget.ring, answer: answer);
    if (mounted) Navigator.of(context).pop(answer);
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final r = widget.ring;
    final who = r.caller.isEmpty ? 'Incoming call' : '${r.caller} is calling';
    return PopScope(
      // Back declines, as Escape does on the web.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _respond(false);
      },
      child: Scaffold(
        backgroundColor: p.bg,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(NeoSpace.xxl),
            child: Column(
              children: [
                const Spacer(),
                Semantics(
                  liveRegion: true,
                  label: '$who into ${r.meetingTitle}',
                  child: Column(
                    children: [
                      Container(
                        width: 112,
                        height: 112,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: p.success.withValues(alpha: 0.18),
                          border: Border.all(color: p.success.withValues(alpha: 0.6), width: 2),
                        ),
                        child: Icon(Icons.phone_in_talk_rounded, size: 52, color: p.success),
                      ),
                      const SizedBox(height: NeoSpace.xxl),
                      Text(
                        (r.groupName.isEmpty ? 'Group call' : r.groupName).toUpperCase(),
                        textAlign: TextAlign.center,
                        style: TextStyle(color: p.textMuted, letterSpacing: 1.4, fontSize: 13),
                      ),
                      const SizedBox(height: NeoSpace.sm),
                      Text(
                        r.meetingTitle,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: p.text),
                      ),
                      const SizedBox(height: NeoSpace.sm),
                      Text(who, textAlign: TextAlign.center, style: TextStyle(color: p.textMuted, fontSize: 16)),
                    ],
                  ),
                ),
                const Spacer(),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _RoundAction(
                      label: 'Decline',
                      icon: Icons.call_end_rounded,
                      color: p.danger,
                      onTap: _busy ? null : () => _respond(false),
                    ),
                    _RoundAction(
                      label: 'Answer',
                      icon: Icons.call_rounded,
                      color: p.success,
                      onTap: _busy ? null : () => _respond(true),
                    ),
                  ],
                ),
                const SizedBox(height: NeoSpace.xxl),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({required this.label, required this.icon, required this.color, required this.onTap});

  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    // The circle and its word are one target: a thumb aimed at "Answer"
    // should answer.
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Material(
              color: color,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onTap,
                child: SizedBox(width: 76, height: 76, child: Icon(icon, color: Colors.white, size: 34)),
              ),
            ),
            const SizedBox(height: NeoSpace.sm),
            Text(label, style: TextStyle(color: p.text)),
          ],
        ),
      ),
    );
  }
}
