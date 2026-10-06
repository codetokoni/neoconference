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
  static IncomingRing? from(Map<String, dynamic> j, DateTime now) {
    if (j['type'] != 'ring' || j['read'] == true) return null;
    final ringId = j['ringId'];
    final slug = j['eventSlug'];
    final expires = j['expiresAt'];
    if (ringId is! String || slug is! String || expires is! num) return null;
    final ring = IncomingRing(
      ringId: ringId,
      eventSlug: slug,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(expires.toInt()),
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

  static Future<void> _call(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } catch (e) {
      debugPrint('[ring] $method: $e');
    }
  }
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

  @override
  ConsumerState<IncomingCallWatcher> createState() => _IncomingCallWatcherState();
}

class _IncomingCallWatcherState extends ConsumerState<IncomingCallWatcher> with WidgetsBindingObserver {
  Timer? _timer;
  bool _checking = false;

  /// Rings already shown, answered or declined: each is shown once.
  final _seen = <String>{};
  IncomingRing? _showing;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _resume();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

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
    if (answered == true && mounted) {
      await joinGroupMeeting(
        context,
        slug: ring.eventSlug,
        title: ring.meetingTitle.isEmpty ? ring.eventSlug : ring.meetingTitle,
        straightIn: true,
      );
    }
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
