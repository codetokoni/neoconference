import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../events/event.dart';

/// What the signed-in account is allowed to do.
///
/// Read from /api/user/plan rather than worked out here, so the app and the
/// server never disagree about what a plan includes — the server is the one
/// that enforces it, and a client that decided for itself would only ever be
/// wrong in a way nobody noticed until a feature quietly refused.
@immutable
class PlanInfo {
  const PlanInfo({
    required this.plan,
    required this.maxParticipants,
    required this.meetingMinutes,
    required this.recording,
    required this.breakouts,
    required this.branding,
    required this.livestream,
    required this.translation,
  });

  /// free | starter | pro | business | enterprise
  final String plan;

  /// 0 means unlimited, matching the server's convention in planLimits.ts.
  final int maxParticipants;
  final int meetingMinutes;

  final bool recording;
  final bool breakouts;
  final bool branding;
  final bool livestream;
  final bool translation;

  bool get isFree => plan == 'free';

  String get participantsLabel =>
      maxParticipants == 0 ? 'Unlimited participants' : '$maxParticipants participants';

  String get minutesLabel =>
      meetingMinutes == 0 ? 'No time limit' : '$meetingMinutes minutes per meeting';

  factory PlanInfo.fromJson(Map<String, dynamic> json) {
    final limits = (json['limits'] as Map?)?.cast<String, dynamic>() ?? const {};
    int asInt(Object? v) => v is num ? v.toInt() : 0;
    return PlanInfo(
      plan: json['plan'] as String? ?? 'free',
      maxParticipants: asInt(limits['maxParticipants']),
      meetingMinutes: asInt(limits['meetingMinutes']),
      recording: limits['recording'] == true,
      breakouts: limits['breakouts'] == true,
      branding: limits['branding'] == true,
      livestream: limits['livestream'] == true,
      translation: limits['translation'] == true,
    );
  }
}

/// Re-read whenever the session changes, so signing in as someone else does
/// not leave the previous person's plan on screen.
final planProvider = FutureProvider<PlanInfo>((ref) async {
  ref.watch(authProvider.select((s) => s.sessionId));
  // A finished purchase arrives on the deep link; re-reading here is what
  // turns the upgrade into something the person can actually see.
  ref.watch(authProvider.select((s) => s.upgradedTo));

  final body = await ref.watch(apiProvider).get('/api/user/plan');
  if (body is! Map<String, dynamic>) {
    throw const FormatException('Unexpected plan response');
  }
  return PlanInfo.fromJson(body);
});
