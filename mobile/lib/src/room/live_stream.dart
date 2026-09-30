import 'package:flutter/foundation.dart';

/// Livestreaming the meeting itself to YouTube, Facebook, Twitch or an
/// RTMP address, through the server's /api/livekit/egress/stream — the
/// same calls the web's Go Live makes (src/lib/livestream.ts).
///
/// A stream key is a secret: it goes to the server once, at start, and is
/// kept nowhere on the phone.

@immutable
class StreamPlatform {
  const StreamPlatform(this.id, this.label, this.keyHint);
  final String id;
  final String label;
  final String keyHint;
}

const streamPlatforms = <StreamPlatform>[
  StreamPlatform('youtube', 'YouTube', 'Stream key from YouTube Studio › Go live'),
  StreamPlatform('facebook', 'Facebook', 'Stream key from Facebook Live Producer'),
  StreamPlatform('twitch', 'Twitch', 'Primary stream key from the Twitch dashboard'),
  StreamPlatform('rtmp', 'Custom RTMP', 'The full rtmp:// or rtmps:// address, key included'),
];

String platformLabel(String id) => streamPlatforms.firstWhere((p) => p.id == id, orElse: () => streamPlatforms.last).label;

/// What the host asks for. Sent, never stored.
@immutable
class StreamDestinationInput {
  const StreamDestinationInput({required this.platform, required this.key, this.label = ''});
  final String platform;
  final String key;
  final String label;

  Map<String, dynamic> toJson() => {'platform': platform, 'key': key, if (label.trim().isNotEmpty) 'label': label.trim()};
}

/// Why a destination cannot be used, or null. The same checks as the
/// server's, so a refusal is said here before anything is sent.
String? destinationProblem(StreamDestinationInput d) {
  final key = d.key.trim();
  if (!streamPlatforms.any((p) => p.id == d.platform)) return 'Unknown platform.';
  if (key.isEmpty) return d.platform == 'rtmp' ? 'Enter the RTMP address.' : 'Enter the stream key.';
  if (d.platform == 'rtmp') {
    return RegExp(r'^rtmps?://\S+$', caseSensitive: false).hasMatch(key) ? null : 'The address must start with rtmp:// or rtmps://.';
  }
  if (RegExp(r'\s').hasMatch(key)) return 'A stream key has no spaces.';
  if (RegExp(r'^rtmps?://', caseSensitive: false).hasMatch(key)) return 'Paste just the stream key, not the whole address.';
  if (key.length < 8 || key.length > 200) return 'That does not look like a stream key.';
  return null;
}

/// One place the meeting is going, as the server reports it.
@immutable
class StreamDestinationView {
  const StreamDestinationView({required this.platform, required this.label, required this.status, this.error});
  final String platform;
  final String label;

  /// connecting | live | ended | failed
  final String status;
  final String? error;

  factory StreamDestinationView.fromJson(Map<String, dynamic> j) => StreamDestinationView(
        platform: j['platform'] as String? ?? 'rtmp',
        label: j['label'] as String? ?? '',
        status: j['status'] as String? ?? 'connecting',
        error: j['error'] as String?,
      );

  String get statusLabel => switch (status) {
        'live' => 'Live',
        'failed' => error == null ? 'Failed' : 'Failed: $error',
        'ended' => 'Ended',
        _ => 'Connecting…',
      };
}

/// The running stream.
@immutable
class LiveStreamView {
  const LiveStreamView({required this.egressId, required this.destinations, this.error});
  final String egressId;
  final List<StreamDestinationView> destinations;
  final String? error;

  static LiveStreamView? fromJson(Map<String, dynamic> j) {
    if (j['live'] != true) return null;
    final list = (j['destinations'] as List? ?? const []).whereType<Map>().map((d) => StreamDestinationView.fromJson(d.cast<String, dynamic>()));
    return LiveStreamView(egressId: j['egressId'] as String? ?? '', destinations: list.toList(), error: j['error'] as String?);
  }

  String get liveOn => liveOnText(destinations.map((d) => d.label).toList());
}

/// "Live on YouTube and Facebook".
String liveOnText(List<String> names) {
  if (names.isEmpty) return 'Live';
  if (names.length == 1) return 'Live on ${names.first}';
  return 'Live on ${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
}
