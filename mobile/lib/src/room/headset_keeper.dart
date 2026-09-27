/// Where Android is sending the call's audio, as the platform reports it.
///
/// [route] is one of `bluetooth` (the headset link: sound and microphone),
/// `bluetooth_media` (sound only — the microphone stays on the phone),
/// `speaker`, `earpiece`, `wired`, `other`, or null. [headset] names a
/// Bluetooth headset that could carry the call, when one is connected.
class CallAudio {
  const CallAudio({this.route, this.headset});

  final String? route;
  final String? headset;

  bool get onHeadset => route == 'bluetooth';

  factory CallAudio.fromMap(Object? raw) {
    final map = raw is Map ? raw : const {};
    return CallAudio(
      route: map['route'] as String?,
      headset: map['headset'] as String?,
    );
  }
}

/// What to do about the call's route after a change.
enum HeadsetAction {
  /// Nothing needs doing.
  none,

  /// The headset link dropped; ask for it back.
  reclaim,

  /// It dropped again right after being asked back: something else keeps
  /// taking it. Stop, and tell the person how to switch back by hand.
  giveUp,
}

/// Keeps a meeting on the Bluetooth headset once it has been there.
///
/// Found on a phone: another calling app claimed call audio, the earbuds
/// closed their headset link, and the meeting stayed on their media link —
/// sound in the ears, microphone on the phone — for as long as it ran.
///
/// This asks for the headset back once. If the link drops again within
/// [contested] of asking, another app is taking it on purpose, and fighting
/// it would flip the audio back and forth; it gives up for the meeting and
/// says so. Choosing the headset by hand ([chosen]) starts over.
class HeadsetKeeper {
  HeadsetKeeper({this.contested = const Duration(seconds: 60)});

  final Duration contested;

  bool _wasOnHeadset = false;
  DateTime? _reclaimedAt;
  bool _gaveUp = false;

  bool get gaveUp => _gaveUp;

  /// The route changed to [audio] at [now]. [speakerChosen] is whether the
  /// person picked the loudspeaker, which always wins.
  HeadsetAction changed(CallAudio audio, DateTime now, {required bool speakerChosen}) {
    if (audio.onHeadset) {
      _wasOnHeadset = true;
      return HeadsetAction.none;
    }
    final dropped = _wasOnHeadset;
    _wasOnHeadset = false;
    // Only a headset that is still there, and only if nobody chose the
    // speaker: moving to the speaker on purpose is not a drop.
    if (!dropped || speakerChosen || audio.headset == null || _gaveUp) {
      return HeadsetAction.none;
    }
    final last = _reclaimedAt;
    if (last != null && now.difference(last) < contested) {
      _gaveUp = true;
      return HeadsetAction.giveUp;
    }
    _reclaimedAt = now;
    return HeadsetAction.reclaim;
  }

  /// The person chose the headset in Audio output: try again from here.
  void chosen() {
    _gaveUp = false;
    _reclaimedAt = null;
  }
}
