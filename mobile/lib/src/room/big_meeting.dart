import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// Big-meeting receiving, as the web room does it (src/lib/bigMeeting.ts).
///
/// LiveKit sends every phone every microphone and camera in the meeting. In
/// the SA meeting of 23 November 2026 (865 people, 638 at once) phones gave
/// up under it and rejoined over and over; it stopped each time a host
/// locked everyone's microphones and cameras. With the meeting owner's
/// "big_meeting_receiving" switch on, the token route answers
/// `receive: "selective"` and this phone subscribes by itself to:
///
///  * microphones: only unmuted ones, at most [maxAudio]: the meeting's
///    Hosts and Moderators first, then whoever spoke or unmuted last;
///  * cameras: only those whose tile is built, which the meeting's grid and
///    rows do only on or near the screen ([ShownTiles]), at most [maxVideo];
///  * screen shares: always.
///
/// And joining a meeting of 50 or more (`joinMuted`), the microphone starts
/// off; the person unmutes to speak.
const maxAudio = 10;

/// Said when a big meeting brought this person in muted.
const joinedMutedMessage =
    'You joined muted because this is a big meeting. Unmute your microphone to speak.';
const maxVideo = 25;

enum PubSource { microphone, camera, screenShare, screenShareAudio, unknown }

@immutable
class PubInfo {
  const PubInfo({
    required this.key,
    required this.identity,
    required this.audio,
    required this.source,
    required this.muted,
  });

  final String key;
  final String identity;
  final bool audio;
  final PubSource source;
  final bool muted;
}

/// Which publications to receive: key → true (subscribe) or false (let go).
Map<String, bool> receivePlan(
  List<PubInfo> pubs, {
  Map<String, int> spokeAt = const {},
  Map<String, int> liveAt = const {},
  Set<String> shown = const {},
  Set<String> priority = const {},
  int audioCap = maxAudio,
  int videoCap = maxVideo,
}) {
  final out = <String, bool>{};
  final mics = <PubInfo>[];
  final cams = <PubInfo>[];
  for (final p in pubs) {
    if (p.source == PubSource.screenShare || p.source == PubSource.screenShareAudio) {
      out[p.key] = true;
    } else if (p.audio) {
      if (p.muted) {
        out[p.key] = false;
      } else {
        mics.add(p);
      }
    } else if (shown.contains(p.identity)) {
      cams.add(p);
    } else {
      out[p.key] = false;
    }
  }
  int recent(PubInfo p) {
    final a = spokeAt[p.identity] ?? 0;
    final b = liveAt[p.key] ?? 0;
    return a > b ? a : b;
  }

  int order(PubInfo a, PubInfo b) {
    final pa = priority.contains(a.identity) ? 1 : 0;
    final pb = priority.contains(b.identity) ? 1 : 0;
    if (pa != pb) return pb - pa;
    return recent(b).compareTo(recent(a));
  }

  mergeSort(mics, compare: order);
  mergeSort(cams, compare: order);
  for (var i = 0; i < mics.length; i++) {
    out[mics[i].key] = i < audioCap;
  }
  for (var i = 0; i < cams.length; i++) {
    out[cams[i].key] = i < videoCap;
  }
  return out;
}

/// One publication to receive or let go, as the controller sees it.
class PlanTarget {
  PlanTarget({required this.info, required this.subscribed, required this.set});

  final PubInfo info;

  /// Whether its track has arrived (LiveKit's own `subscribed`).
  final bool subscribed;

  /// Asks LiveKit to subscribe (true) or unsubscribe (false).
  final Future<void> Function(bool want) set;
}

/// Asks LiveKit for what the plan says, once per change: a subscription
/// reads as subscribed only when its track arrives, so without remembering
/// what was asked every re-plan in between would ask again.
class ReceiveApplier {
  final _asked = <String, bool>{};

  /// A new connection has its own subscriptions.
  void reset() => _asked.clear();

  /// Applies [plan] to [targets]; returns how many requests it sent.
  int apply(List<PlanTarget> targets, Map<String, bool> plan) {
    final byKey = {for (final t in targets) t.info.key: t};
    _asked.removeWhere((key, _) => !byKey.containsKey(key));
    var sent = 0;
    plan.forEach((key, want) {
      final t = byKey[key];
      if (t == null || _asked[key] == want) return;
      _asked[key] = want;
      if (t.subscribed == want) return;
      sent++;
      t.set(want).catchError((Object e) {
        debugPrint('[neo-room] receive plan: $e');
      });
    });
    return sent;
  }
}

/// What the token route said about receiving.
@immutable
class ReceiveMode {
  const ReceiveMode({this.selective = false, this.joinMuted = false});

  factory ReceiveMode.of(Map<String, dynamic> body) => ReceiveMode(
        selective: body['receive'] == 'selective',
        joinMuted: body['joinMuted'] == true,
      );

  final bool selective;
  final bool joinMuted;
}

/// The people whose tile is built right now. The meeting's grid and rows
/// build tiles lazily, only on or near the screen, so this is who is on
/// screen. A person can have more than one tile (the pinned row and the
/// grid): counted, so the last one going takes them off.
class ShownTiles extends ChangeNotifier {
  ShownTiles._();

  static final instance = ShownTiles._();

  final _counts = <String, int>{};

  Set<String> get ids => _counts.keys.toSet();

  void add(String id) {
    final n = (_counts[id] ?? 0) + 1;
    _counts[id] = n;
    if (n == 1) notifyListeners();
  }

  void remove(String id) {
    final n = (_counts[id] ?? 0) - 1;
    if (n <= 0) {
      if (_counts.remove(id) != null) notifyListeners();
    } else {
      _counts[id] = n;
    }
  }

  @visibleForTesting
  void clear() => _counts.clear();
}

/// Wrap a person's tile: they count as shown while it is built.
class ShownTile extends StatefulWidget {
  const ShownTile({super.key, required this.id, required this.child});

  final String id;
  final Widget child;

  @override
  State<ShownTile> createState() => _ShownTileState();
}

class _ShownTileState extends State<ShownTile> {
  @override
  void initState() {
    super.initState();
    ShownTiles.instance.add(widget.id);
  }

  @override
  void didUpdateWidget(ShownTile old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id) {
      ShownTiles.instance.remove(old.id);
      ShownTiles.instance.add(widget.id);
    }
  }

  @override
  void dispose() {
    ShownTiles.instance.remove(widget.id);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
