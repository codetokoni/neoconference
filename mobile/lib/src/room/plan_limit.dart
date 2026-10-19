import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'meeting_drop.dart';

/// What the meeting owner's plan allows in this meeting, as the token
/// route writes it into every participant's metadata:
/// `{planLimits: {meetingMinutes, recording, ...}, hostPlan, role}`.
///
/// The web reads the same thing (src/components/PlanGateOverlay.tsx) to
/// run its countdown and hide Record. Billing is per host, so it is the
/// owner's plan, never the joiner's.
@immutable
class MeetingPlanLimits {
  const MeetingPlanLimits({required this.meetingMinutes, required this.recording, this.livestream = false, this.translation = true});

  /// 0 means no limit, as in planLimits.ts.
  final int meetingMinutes;
  final bool recording;

  /// Go Live to YouTube, Facebook, Twitch or RTMP: Enterprise.
  final bool livestream;

  /// Live translation: Pro and above. True when an older token does not
  /// say; the server refuses anyway (/api/translate with the room).
  final bool translation;

  /// Null when the metadata says nothing about the plan (an older token);
  /// the server still enforces recording either way.
  static MeetingPlanLimits? fromMetadata(String? metadata) {
    if (metadata == null || metadata.isEmpty) return null;
    try {
      final decoded = jsonDecode(metadata);
      final limits = decoded is Map ? decoded['planLimits'] : null;
      if (limits is! Map) return null;
      final minutes = limits['meetingMinutes'];
      return MeetingPlanLimits(
        meetingMinutes: minutes is num && minutes > 0 ? minutes.toInt() : 0,
        recording: limits['recording'] == true,
        livestream: limits['livestream'] == true,
        translation: limits['translation'] != false,
      );
    } catch (_) {
      return null;
    }
  }
}

/// How the meeting ends when the owner's plan runs out of minutes.
///
/// Rejoin is offered, as the web allows: the limit is per sitting, counted
/// from joining, exactly as PlanGateOverlay counts it.
MeetingDrop timeLimitDrop(int minutes) => MeetingDrop(
      headline: 'Time limit reached',
      message: "This meeting reached the $minutes-minute limit of its owner's "
          'plan. The owner can upgrade at neolinguameet.com/pricing for '
          'longer meetings.',
      canRejoin: true,
    );

/// Counts a plan's meeting minutes down from joining: says so five minutes
/// and one minute before, then ends it.
class MeetingTimeLimit {
  MeetingTimeLimit({required this.onWarn, required this.onEnd});

  /// With the whole minutes left: 5, then 1.
  final void Function(int minutesLeft) onWarn;
  final void Function(int limitMinutes) onEnd;

  final List<Timer> _timers = [];

  bool get running => _timers.any((t) => t.isActive);

  /// Starts counting [minutes] from now. Does nothing for 0 (no limit) or
  /// when already counting: a rejoin after a dropped connection is the same
  /// sitting, and restarting the clock would hand out free minutes.
  void start(int minutes) {
    if (minutes <= 0 || running) return;
    final total = Duration(minutes: minutes);
    for (final left in const [5, 1]) {
      final at = total - Duration(minutes: left);
      if (at > Duration.zero) _timers.add(Timer(at, () => onWarn(left)));
    }
    _timers.add(Timer(total, () {
      cancel();
      onEnd(minutes);
    }));
  }

  void cancel() {
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
  }
}

/// What a listener is told when the meeting's plan has no live translation.
const proTranslationNote =
    "Live translation is on the Pro plan and above. This meeting's owner "
    'can upgrade at neolinguameet.com/pricing.';

/// Whether this person was added to the meeting by name and so may record
/// though not a host (the token's `canRecord`; owner's decision 2026-10-15).
bool addedCanRecord(String? metadata) {
  if (metadata == null || metadata.isEmpty) return false;
  try {
    final decoded = jsonDecode(metadata);
    return decoded is Map && decoded['canRecord'] == true;
  } catch (_) {
    return false;
  }
}
