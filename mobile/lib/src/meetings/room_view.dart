import 'package:flutter/widgets.dart';

/// How connected the meeting currently is.
///
/// Separate from whether we joined. A call can be fully joined and silently
/// dead, and the header must never claim otherwise — a stale participant
/// count is worse than none, because people act on it.
/// [weak] has no source in production yet: LiveKit reports connection
/// quality, but nothing in the room controller subscribes to it. The state
/// exists because the design covers it and it stays reviewable; production
/// never sets it, rather than guessing at it from something else.
enum RoomLinkState { live, weak, reconnecting, lost }

enum RoomLayout { speaker, grid }

/// What the meeting screen needs to draw one person.
///
/// [video] is a built widget rather than a track, because the two sides
/// render differently: production hands over LiveKit's renderer, the
/// showcase a gradient. Null means no video, and the tile shows an avatar.
@immutable
class PersonView {
  const PersonView({
    required this.id,
    required this.name,
    this.video,
    this.muted = true,
    this.speaking = false,
    this.handRaised = false,
    this.sharing = false,
    this.isMe = false,
  });

  final String id;
  final String name;
  final Widget? video;
  final bool muted;
  final bool speaking;
  final bool handRaised;
  final bool sharing;
  final bool isMe;

  bool get cameraOn => video != null;
}

/// The meeting, as the screen sees it.
@immutable
class RoomView {
  const RoomView({
    required this.title,
    required this.people,
    required this.link,
    required this.elapsed,
    this.micOn = false,
    this.cameraOn = false,
    this.screenSharing = false,
    this.handRaised = false,
    this.recording = false,
    this.canManage = false,
    this.unreadChat = 0,
    this.waitingCount = 0,
    this.onPhoneCall = false,
  });

  final String title;
  final List<PersonView> people;
  final RoomLinkState link;

  /// How long this device has been in the meeting.
  final Duration elapsed;

  final bool micOn;
  final bool cameraOn;
  final bool screenSharing;
  final bool handRaised;
  final bool recording;

  /// Whether the server would accept a moderation request from this
  /// person. Showing the controls is a convenience; the server checks the
  /// role again on every one of them.
  final bool canManage;

  final int unreadChat;
  final int waitingCount;

  /// A phone call has this device's microphone. Shown for as long as it
  /// lasts, because a snackbar is gone before anyone looks back at the
  /// meeting.
  final bool onPhoneCall;

  /// Whoever is sharing, else whoever is speaking, else the first person
  /// who is not this device.
  ///
  /// Falls back to this device only when nobody else is here, so a meeting
  /// of one shows something rather than an empty stage.
  PersonView? get focus {
    if (people.isEmpty) return null;
    for (final person in people) {
      if (person.sharing) return person;
    }
    for (final person in people) {
      if (person.speaking && !person.isMe) return person;
    }
    for (final person in people) {
      if (!person.isMe) return person;
    }
    return people.first;
  }

  List<PersonView> get others =>
      [for (final person in people) if (person != focus) person];

  /// mm:ss, or h:mm:ss once it has been going that long.
  String get clock {
    final m = elapsed.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = elapsed.inSeconds.remainder(60).toString().padLeft(2, '0');
    final h = elapsed.inHours;
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }
}

/// What the screen can ask the meeting to do.
///
/// Callbacks rather than a controller interface, so the screen has no
/// opinion about whether it is driving LiveKit or a sample.
@immutable
class RoomActions {
  const RoomActions({
    required this.toggleMic,
    required this.toggleCamera,
    required this.toggleHand,
    required this.leave,
    this.switchCamera,
    this.toggleScreenShare,
    this.react,
    this.enterPip,
    this.openAudioOutput,
    this.audioOutputLabel,
    this.openTranslation,
    this.translationLabel,
    this.openDetails,
    this.openChat,
    this.openParticipants,
    this.openHostControls,
    this.openWaitingRoom,
  });

  final Future<void> Function() toggleMic;
  final Future<void> Function() toggleCamera;
  final Future<void> Function() toggleHand;
  final Future<void> Function() leave;

  /// Null where the action is not available, which is how the screen knows
  /// to leave the control out rather than show one that does nothing.
  final Future<void> Function()? switchCamera;
  final Future<void> Function()? toggleScreenShare;
  final void Function(String key)? react;

  /// Float the meeting into a Picture in Picture window. Null where the
  /// platform has no such thing, so the control is absent rather than
  /// present and inert.
  final Future<bool> Function()? enterPip;

  /// Open the audio output picker. Null where the platform does not let an
  /// app move the audio.
  final VoidCallback? openAudioOutput;

  /// What the sound is currently coming out of, for the row's subtitle.
  final String? audioOutputLabel;

  /// Open the live-translation picker, and what it currently reads.
  final VoidCallback? openTranslation;
  final String? translationLabel;

  /// Open the meeting's details.
  final VoidCallback? openDetails;

  final VoidCallback? openChat;
  final VoidCallback? openParticipants;
  final VoidCallback? openHostControls;
  final VoidCallback? openWaitingRoom;
}
