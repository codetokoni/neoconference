import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../events/event.dart';
import 'meeting_drop.dart';
import 'meeting_presence.dart';
import 'phone_call_policy.dart';
import 'reconnect_watchdog.dart';
import 'weak_link.dart';
import '../settings/meeting_defaults.dart';

/// Data-channel topics, matching the web client exactly.
///
/// These strings are the wire protocol between this app and every browser
/// already in the room, so they are copied from the components that define
/// them (ChatPanel.tsx, ReactionsBar.tsx, RaiseHandButton.tsx) rather than
/// invented here. Changing one in isolation would split the room in two.
class Topics {
  const Topics._();
  static const chat = 'neo-chat';
  static const typing = 'neo-typing';
  static const moderation = 'neo-mod';
  static const reactions = 'neo-reactions';
  static const hand = 'neo-hand';
}

/// Whether the app still has a working link to the meeting.
///
/// Separate from [JoinPhase], which is about getting in. This is about
/// staying in: a call can be fully joined and silently dead.
enum RoomLink { live, reconnecting, lost }

/// Why the app is not in the room yet.
enum JoinPhase {
  connecting,

  /// The host has not arrived. The room exists; nobody may publish into an
  /// empty meeting until someone hosts it.
  waitingForHost,

  /// Knocked at the waiting room, waiting on a host to admit.
  knocking,

  /// A host said no.
  denied,
  locked,
  full,
  failed,
  connected,
}

@immutable
class ChatLine {
  const ChatLine({
    required this.id,
    required this.name,
    required this.text,
    required this.at,
    this.isDirect = false,
  });

  final String id;
  final String name;
  final String text;
  final DateTime at;
  final bool isDirect;

  factory ChatLine.fromJson(Map<String, dynamic> json) => ChatLine(
        id: json['id'] as String? ?? '${json['ts']}-${json['userId']}',
        name: json['name'] as String? ?? 'Someone',
        text: json['text'] as String? ?? '',
        at: DateTime.tryParse(json['ts'] as String? ?? '')?.toLocal() ??
            DateTime.now(),
        isDirect: json['toUserId'] != null,
      );
}

@immutable
class Reaction {
  const Reaction(this.emoji, this.at);
  final String emoji;
  final DateTime at;
}

@immutable
class RoomState {
  const RoomState({
    this.phase = JoinPhase.connecting,
    this.message,
    this.role = 'guest',
    this.micOn = false,
    this.cameraOn = false,
    this.screenSharing = false,
    this.handRaised = false,
    this.chat = const [],
    this.reactions = const [],
    this.raisedHands = const {},
    this.waitingRoom = const [],
    this.recordingEgressId,
    this.unreadChat = 0,
    this.chatError,
    this.chatPacketsSeen = 0,
    this.dataPacketsSeen = 0,
    this.lastDataTopic,
    this.lastDataError,
    this.link = RoomLink.live,
    this.translateTo,
    this.caption,
    this.translatedCaption,
    this.transcriptionsSeen = 0,
    this.translationError,
    this.onPhoneCall = false,
    this.mutedByPhoneCall = false,
    this.weakLink = false,
    this.drop,
  });

  final JoinPhase phase;
  final String? message;

  /// host | cohost | speaker | viewer | attendee | guest
  final String role;
  final bool micOn;
  final bool cameraOn;
  final bool screenSharing;
  final bool handRaised;
  final List<ChatLine> chat;
  final List<Reaction> reactions;

  /// identity -> display name, for everyone currently raising a hand.
  final Map<String, String> raisedHands;
  final List<Map<String, dynamic>> waitingRoom;
  final String? recordingEgressId;
  final int unreadChat;

  /// Why the chat is empty, when it is empty for a reason.
  final String? chatError;

  /// How many `neo-chat` packets have arrived over the data channel.
  ///
  /// Shown in the chat sheet because "nobody has typed" and "messages are
  /// arriving but not being displayed" look identical otherwise, and they
  /// need opposite fixes.
  final int chatPacketsSeen;

  /// Every data packet that reached the app, whatever its topic and whether
  /// or not it could be decoded, plus what the last one looked like.
  final int dataPacketsSeen;
  final String? lastDataTopic;
  final String? lastDataError;

  /// Whether the meeting is still actually reachable.
  final RoomLink link;

  /// The language captions are being translated into, or null for off.
  final String? translateTo;

  /// The most recent final caption, as spoken.
  final String? caption;

  /// That caption in [translateTo]. Null while it is being fetched.
  final String? translatedCaption;

  /// How many transcription segments have arrived from LiveKit.
  ///
  /// Kept because "nobody is speaking" and "captions are not reaching this
  /// device" look identical on screen and need opposite fixes — the same
  /// reason the chat packet counters exist. Inbound data on this SDK is
  /// the subject of livekit/client-sdk-flutter#1221, and transcriptions
  /// travel the same path.
  final int transcriptionsSeen;

  /// Why a translation did not appear, when it did not.
  final String? translationError;

  /// A phone call is ringing or in progress on this device.
  final bool onPhoneCall;

  /// The microphone is off because of that call rather than by choice, so
  /// hanging up knows there is something to tell the person.
  final bool mutedByPhoneCall;

  /// LiveKit rates this device's own connection as poor. Separate from
  /// [link]: a weak meeting is still connected, and its participant count
  /// is still true.
  final bool weakLink;

  /// Set when a meeting this device was in ended under it — as opposed
  /// to a join that never got in, which keeps using [message].
  final MeetingDrop? drop;

  bool get canManage => role == 'host' || role == 'cohost';
  bool get isRecording => recordingEgressId != null;
  bool get inRoom => phase == JoinPhase.connected;

  RoomState copyWith({
    JoinPhase? phase,
    String? message,
    String? role,
    bool? micOn,
    bool? cameraOn,
    bool? screenSharing,
    bool? handRaised,
    List<ChatLine>? chat,
    List<Reaction>? reactions,
    Map<String, String>? raisedHands,
    List<Map<String, dynamic>>? waitingRoom,
    String? recordingEgressId,
    int? unreadChat,
    String? chatError,
    int? chatPacketsSeen,
    int? dataPacketsSeen,
    String? lastDataTopic,
    String? lastDataError,
    RoomLink? link,
    String? translateTo,
    String? caption,
    String? translatedCaption,
    int? transcriptionsSeen,
    String? translationError,
    bool? onPhoneCall,
    bool? mutedByPhoneCall,
    bool? weakLink,
    MeetingDrop? drop,
    bool clearMessage = false,
    bool clearRecording = false,
    bool clearChatError = false,
    bool clearTranslation = false,
    bool clearTranslatedCaption = false,
    bool clearTranslationError = false,
    bool clearDrop = false,
  }) =>
      RoomState(
        phase: phase ?? this.phase,
        message: clearMessage ? null : (message ?? this.message),
        role: role ?? this.role,
        micOn: micOn ?? this.micOn,
        cameraOn: cameraOn ?? this.cameraOn,
        screenSharing: screenSharing ?? this.screenSharing,
        handRaised: handRaised ?? this.handRaised,
        chat: chat ?? this.chat,
        reactions: reactions ?? this.reactions,
        raisedHands: raisedHands ?? this.raisedHands,
        waitingRoom: waitingRoom ?? this.waitingRoom,
        recordingEgressId:
            clearRecording ? null : (recordingEgressId ?? this.recordingEgressId),
        unreadChat: unreadChat ?? this.unreadChat,
        chatError: clearChatError ? null : (chatError ?? this.chatError),
        chatPacketsSeen: chatPacketsSeen ?? this.chatPacketsSeen,
        dataPacketsSeen: dataPacketsSeen ?? this.dataPacketsSeen,
        lastDataTopic: lastDataTopic ?? this.lastDataTopic,
        lastDataError: lastDataError ?? this.lastDataError,
        link: link ?? this.link,
        translateTo: clearTranslation ? null : (translateTo ?? this.translateTo),
        caption: caption ?? this.caption,
        translatedCaption: clearTranslatedCaption
            ? null
            : (translatedCaption ?? this.translatedCaption),
        transcriptionsSeen: transcriptionsSeen ?? this.transcriptionsSeen,
        translationError: clearTranslationError
            ? null
            : (translationError ?? this.translationError),
        onPhoneCall: onPhoneCall ?? this.onPhoneCall,
        mutedByPhoneCall: mutedByPhoneCall ?? this.mutedByPhoneCall,
        weakLink: weakLink ?? this.weakLink,
        drop: clearDrop ? null : (drop ?? this.drop),
      );
}

/// Joining a meeting and everything that happens inside it.
///
/// The server decides who may do what; this asks and reports. Nothing here
/// grants a permission locally — a viewer's microphone button is absent
/// because LiveKit refuses the publish, not because the app hid it.
class RoomController extends StateNotifier<RoomState> {
  RoomController({required this.api, required this.slug})
      : super(const RoomState()) {
    // Lifecycle tracing (debug only). A meeting that keeps restarting looks
    // identical from outside whether this app is throwing the connection
    // away and rebuilding it, or the SDK is reconnecting underneath a
    // controller that never moved. Those have opposite owners.
    debugPrint('[neo-room] controller created for $slug');
  }

  final ApiClient api;
  final String slug;

  static Room _newRoom() => Room(
        roomOptions: const RoomOptions(
          adaptiveStream: true,
          // A phone on mobile data should send fewer layers, not choke.
          dynacast: true,
        ),
      );

  Room _room = _newRoom();
  bool _roomUsed = false;

  /// The current meeting connection. Replaced on every connect after the
  /// first, so read it fresh rather than holding on to it.
  Room get room => _room;

  EventsListener<RoomEvent>? _listener;
  Timer? _knockTimer;
  Timer? _hostTimer;
  Timer? _chatTimer;
  bool _disposed = false;

  late final _reconnectWatchdog = ReconnectWatchdog(onGiveUp: _giveUpReconnecting);

  late final _weakLink = WeakLinkPolicy(onChange: (weak) {
    if (_disposed) return;
    debugPrint('[neo-room] connection ${weak ? 'weak' : 'recovered'}');
    state = state.copyWith(weakLink: weak);
  });

  Future<void> join() async {
    debugPrint('[neo-room] join() called for $slug');
    state = state.copyWith(
      phase: JoinPhase.connecting,
      clearMessage: true,
      clearDrop: true,
    );
    try {
      await _resolveRole();
      final creds = await _token();
      if (creds == null) return; // A gate answered; the timer will retry.
      await _connect(creds['token'] as String, creds['wsUrl'] as String);
    } on ApiException catch (e) {
      _handleJoinRefusal(e);
    } catch (e) {
      state = state.copyWith(
        phase: JoinPhase.failed,
        message: 'Could not join: $e',
      );
    }
  }

  /// Distinguishes this phone from the same person's other devices.
  ///
  /// The token route sets the LiveKit identity to the Clerk user id, plus
  /// `#nonce` when one is given. LiveKit disconnects the older participant
  /// when a duplicate identity joins, so without a nonce a person signed in
  /// on both their phone and a browser kicks themselves out of the meeting —
  /// each client alone in the room, publishing to nobody, with no error. The
  /// web client sends a per-tab nonce for exactly this reason.
  ///
  /// Kept in storage rather than generated per join, so that rejoining
  /// replaces this phone's own stale participant instead of piling up
  /// ghosts beside it.
  String? _nonce;

  Future<String?> _ensureNonce() async {
    if (_nonce != null) return _nonce;
    try {
      final prefs = await SharedPreferences.getInstance();
      var value = prefs.getString(_nonceKey);
      if (value == null || value.isEmpty) {
        // The token route accepts [A-Za-z0-9_-]{1,32}.
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        final rng = Random.secure();
        value = List.generate(16, (_) => alphabet[rng.nextInt(alphabet.length)])
            .join();
        await prefs.setString(_nonceKey, value);
      }
      _nonce = value;
    } catch (_) {
      // Storage refused. A nonce that lasts only this run is still far
      // better than none, which would collide with the person's browser.
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      final rng = Random.secure();
      _nonce =
          List.generate(16, (_) => alphabet[rng.nextInt(alphabet.length)]).join();
    }
    return _nonce;
  }

  static const _nonceKey = 'neo.livekit.nonce';

  /// The LiveKit room to join, which is not always the slug.
  ///
  /// An event carries its own `livekitRoom`, and middleware sends a browser
  /// to `/room/<livekitRoom>?event=<slug>`. Joining by the slug instead puts
  /// this app in a different room: it connects, publishes happily, and hears
  /// nobody — no error anywhere, because an empty room is a valid room.
  String? _livekitRoom;

  Future<void> _resolveRole() async {
    try {
      final body = await api.get('/api/events/role', {'slug': slug});
      if (body is! Map) return;
      final role = body['role'] as String?;
      if (role != null) state = state.copyWith(role: role);
      final room = body['livekitRoom'] as String?;
      if (room != null && room.isNotEmpty) _livekitRoom = room;
    } on ApiException {
      // Role is a convenience for showing host controls; the server checks
      // it again on every action. The room name is not a convenience, so if
      // this failed the join below falls back to the slug and says as much
      // rather than silently landing somewhere else.
    }
  }

  /// Asks for a LiveKit token. Returns null when a gate answered instead,
  /// having already moved the state to the right waiting screen.
  Future<Map<String, dynamic>?> _token() async {
    // `event` stays the slug — that is what the gating and role lookups key
    // on — while `room` is the LiveKit room the browser also joins.
    final nonce = await _ensureNonce();
    final body = await api.get('/api/livekit/token', {
      'room': _livekitRoom ?? slug,
      'event': slug,
      'nonce': ?nonce,
    });
    if (body is! Map || body['token'] is! String || body['wsUrl'] is! String) {
      throw const ApiException(
        status: 500,
        message: 'The server did not return a way to connect.',
      );
    }
    return body.cast<String, dynamic>();
  }

  void _handleJoinRefusal(ApiException e) {
    switch (e.code) {
      case 'waiting_room':
        _beginKnocking(e.body['status'] as String?);
      case 'wait_for_host':
        state = state.copyWith(
          phase: JoinPhase.waitingForHost,
          message: 'Waiting for the host to start the meeting.',
        );
        _hostTimer ??= Timer.periodic(const Duration(seconds: 5), (_) => _retry());
      case 'meeting_locked':
        state = state.copyWith(
          phase: JoinPhase.locked,
          message: e.message.isNotEmpty
              ? e.message
              : 'This meeting is locked. Ask the host to let you in.',
        );
      case 'room_full':
        state = state.copyWith(
          phase: JoinPhase.full,
          message: e.message.isNotEmpty ? e.message : 'This meeting is full.',
        );
      default:
        state = state.copyWith(phase: JoinPhase.failed, message: e.message);
    }
  }

  void _beginKnocking(String? status) {
    if (status == 'denied') {
      state = state.copyWith(
        phase: JoinPhase.denied,
        message: 'The host did not admit you.',
      );
      return;
    }
    state = state.copyWith(
      phase: JoinPhase.knocking,
      message: 'Waiting for the host to let you in.',
    );
    unawaited(_knock());
    // Same cadence as the web room, so a host sees one queue, not two.
    _knockTimer ??= Timer.periodic(const Duration(seconds: 4), (_) => _knock());
  }

  Future<void> _knock() async {
    if (_disposed) return;
    try {
      final body = await api.post('/api/waiting-room', {'op': 'knock', 'slug': slug});
      final status = (body is Map ? body['status'] : null) as String?;
      if (status == 'admitted') {
        _knockTimer?.cancel();
        _knockTimer = null;
        await join();
      } else if (status == 'denied') {
        _knockTimer?.cancel();
        _knockTimer = null;
        state = state.copyWith(
          phase: JoinPhase.denied,
          message: 'The host did not admit you.',
        );
      }
    } on ApiException {
      // Transient; the next tick tries again.
    }
  }

  Future<void> _retry() async {
    if (_disposed || state.phase == JoinPhase.connected) return;
    try {
      final creds = await _token();
      if (creds == null) return;
      _hostTimer?.cancel();
      _hostTimer = null;
      await _connect(creds['token'] as String, creds['wsUrl'] as String);
    } on ApiException {
      // Still gated. Leave the waiting screen as it is.
    }
  }

  Future<void> _connect(String token, String wsUrl) async {
    // A retry after a dropped meeting comes back through here on the same
    // controller. Without disposing the old listener every room event was
    // handled twice from then on — seen as each connection-quality report
    // logged twice at the same millisecond.
    await _listener?.dispose();
    // And a fresh Room. Rejoining on the one that had been given up on
    // mid-reconnect never got in: LiveKit threw TimeoutExceptions from
    // its participant updates and the screen sat on "Joining" for minutes.
    if (_roomUsed) {
      final old = _room;
      _room = _newRoom();
      unawaited(old.disconnect().then((_) => old.dispose()));
    }
    _roomUsed = true;
    _listener = room.createListener();
    _wireEvents();
    await room.connect(wsUrl, token);
    // link: a rejoin after a drop comes through here with the link still
    // marked lost, and the header would go on saying "Connection lost"
    // over a working meeting.
    state = state.copyWith(
      phase: JoinPhase.connected,
      link: RoomLink.live,
      clearMessage: true,
    );

    // The foreground service starts here rather than at join, because
    // Android 14 only allows a microphone-type service to be started while
    // the app is in the foreground, and only once there is actually a
    // meeting to keep alive. Without it the process is descheduled within
    // seconds of the phone being pocketed and the audio stops.
    //
    // The slug rather than the meeting's name: the controller is keyed by
    // slug and never receives the name, and on this account most meetings
    // are named after their slug anyway.
    unawaited(MeetingPresence.instance.begin(title: slug));

    // Asked here because this is where it is needed and where the reason
    // is obvious: without BLUETOOTH_CONNECT, Android routes the call to
    // the earpiece even with earbuds connected.
    unawaited(MeetingPresence.instance.ensureBluetooth());

    // And for the same reason, READ_PHONE_STATE: without it a phone call
    // takes the microphone and the meeting never finds out.
    // Removed first for the same retry: ValueNotifier keeps duplicates, and
    // a call would then be handled twice.
    MeetingPresence.instance.onPhoneCall
      ..removeListener(_onPhoneCall)
      ..addListener(_onPhoneCall);
    unawaited(MeetingPresence.instance.ensurePhoneState());

    // Join muted with the camera off unless Settings says otherwise.
    // Arriving already broadcasting is a rude surprise on a phone, which is
    // likely to be somewhere personal, so that stays the default — but a
    // switch that only claims to change this would be worse than not
    // offering it, so the preference is honoured here.
    await _applyJoinDefaults();

    await _loadChatHistory();
    _startChatPolling();
    if (state.canManage) unawaited(refreshWaitingRoom());
  }

  /// Turns on whatever the person asked to join with.
  ///
  /// Failures are swallowed on purpose: a camera another app is holding, or
  /// a microphone permission that has just been revoked, should not turn a
  /// successful join into a failed one. The meeting is already connected by
  /// this point, and the controls are right there to try again.
  Future<void> _applyJoinDefaults() async {
    final me = room.localParticipant;
    if (me == null) return;
    try {
      if (!await MeetingDefaults.joinMuted()) {
        await me.setMicrophoneEnabled(true);
      }
      if (!await MeetingDefaults.joinCameraOff()) {
        await me.setCameraEnabled(true);
      }
    } catch (_) {
      // Joined muted, which is the safe end to fail towards.
    }
    if (_disposed) return;
    _syncLocalMedia();
  }

  void _wireEvents() {
    _listener!
      ..on<DataReceivedEvent>(_onData)
      // A meeting that has quietly died must not keep claiming it is live.
      //
      // Found on a real phone: the signal socket dropped and retried every
      // five seconds for minutes while the header still read "2 in the
      // meeting" and the tiles still showed everyone. Someone who pockets
      // their phone falls out of the call and the screen tells them they
      // are still in it, which is worse than showing nothing.
      ..on<RoomReconnectingEvent>((_) {
        if (_disposed) return;
        _reconnectWatchdog.reconnecting();
        state = state.copyWith(link: RoomLink.reconnecting);
      })
      ..on<RoomResumingEvent>((_) {
        if (_disposed) return;
        _reconnectWatchdog.reconnecting();
        state = state.copyWith(link: RoomLink.reconnecting);
      })
      ..on<RoomReconnectedEvent>((_) {
        if (_disposed) return;
        _reconnectWatchdog.settled();
        state = state.copyWith(link: RoomLink.live);
        // Anything published while the link was down never arrived, so the
        // history is the only way back to a correct chat.
        unawaited(_loadChatHistory(merge: true));
      })
      ..on<RoomDisconnectedEvent>((e) {
        if (_disposed) return;
        _reconnectWatchdog.settled();
        debugPrint('[neo-room] disconnected: ${e.reason}');
        final drop = describeDrop(e.reason);
        // A dropped meeting is not a meeting. Left running, the service
        // kept the "you are in a meeting" notification up over the
        // disconnected screen.
        if (drop != null) unawaited(MeetingPresence.instance.end());
        state = state.copyWith(
          phase: JoinPhase.failed,
          link: RoomLink.lost,
          drop: drop,
          message: 'Disconnected from the meeting.',
        );
      })
      // Mute events arrive for everyone, not just this device. Syncing our
      // own buttons is enough to redraw someone else's microphone icon too:
      // every state write is a new object, and StateNotifier notifies on
      // identity, so the participant list rebuilds from the same write.
      ..on<TranscriptionEvent>(_onTranscription)
      // Only this device's own rating. Someone else's poor link is theirs
      // to see; showing it here would tell this person their meeting is
      // breaking up when it is not.
      ..on<ParticipantConnectionQualityUpdatedEvent>((e) {
        if (_disposed || e.participant is! LocalParticipant) return;
        // Every report, not just the transitions: when "weak" never shows,
        // this says whether the server rated the link at all.
        debugPrint('[neo-room] connection quality ${e.connectionQuality.name}');
        _weakLink.report(e.connectionQuality);
      })
      ..on<TrackMutedEvent>((_) => _syncLocalMedia())
      ..on<TrackUnmutedEvent>((_) => _syncLocalMedia())
      ..on<ParticipantConnectedEvent>((_) => _bump())
      ..on<ParticipantDisconnectedEvent>((e) {
        final hands = Map<String, String>.from(state.raisedHands)
          ..remove(e.participant.identity);
        state = state.copyWith(raisedHands: hands);
      })
      ..on<TrackSubscribedEvent>((_) => _bump())
      ..on<TrackUnsubscribedEvent>((_) => _bump())
      ..on<TrackPublishedEvent>((_) => _bump())
      ..on<TrackUnpublishedEvent>((_) => _bump())
      ..on<ActiveSpeakersChangedEvent>((_) => _bump());
  }

  /// The reconnect has taken too long to be coming back. Treated as a
  /// drop: the person gets Rejoin rather than a spinner that never ends.
  ///
  /// The disconnect that follows reports itself as client-initiated, which
  /// describes nothing, so the drop is set here first and the handler
  /// keeps it.
  void _giveUpReconnecting() {
    if (_disposed || state.link != RoomLink.reconnecting) return;
    debugPrint('[neo-room] gave up reconnecting after '
        '${_reconnectWatchdog.timeout.inSeconds}s');
    unawaited(MeetingPresence.instance.end());
    state = state.copyWith(
      phase: JoinPhase.failed,
      link: RoomLink.lost,
      drop: describeDrop(DisconnectReason.reconnectAttemptsExceeded),
    );
    unawaited(room.disconnect());
  }

  /// LiveKit holds participant state on its own objects, so the UI needs a
  /// nudge to rebuild when a track appears or a speaker changes.
  void _bump() {
    if (!_disposed) state = state.copyWith();
  }

  void _syncLocalMedia() {
    final me = room.localParticipant;
    if (me == null) return;
    state = state.copyWith(
      micOn: me.isMicrophoneEnabled(),
      cameraOn: me.isCameraEnabled(),
      screenSharing: me.isScreenShareEnabled(),
    );
  }

  /// A phone call started or ended on this device.
  ///
  /// The judgement is [decidePhoneCall]'s; this only carries it out. The
  /// notice goes through [RoomState.message], which the room shows as a
  /// snackbar, and the ongoing state drives a banner for as long as the
  /// call lasts.
  Future<void> _onPhoneCall() async {
    if (_disposed) return;
    final inCall = MeetingPresence.instance.onPhoneCall.value;
    final me = room.localParticipant;

    final outcome = decidePhoneCall(
      inCall: inCall,
      micOn: me?.isMicrophoneEnabled() ?? false,
      mutedByCall: state.mutedByPhoneCall,
    );

    if (outcome.muteMic && me != null) {
      try {
        await me.setMicrophoneEnabled(false);
      } catch (e) {
        // Android has already given the microphone to the call, so a
        // failure here means it was not ours to switch off. The state
        // below still records the call.
        debugPrint('[neo-room] could not mute for a phone call: $e');
      }
    }
    if (_disposed) return;

    _syncLocalMedia();
    state = state.copyWith(
      onPhoneCall: inCall,
      mutedByPhoneCall: outcome.mutedByCall,
      message: outcome.notice,
    );
  }

  /// Captions from the meeting's transcription pipeline.
  ///
  /// Counted before anything can go wrong with them, for the same reason
  /// the data packets are: "nobody is speaking" and "captions are not
  /// reaching this device" look identical on screen, and a count is the
  /// only thing that tells them apart.
  void _onTranscription(TranscriptionEvent event) {
    if (_disposed) return;

    state = state.copyWith(
      transcriptionsSeen: state.transcriptionsSeen + event.segments.length,
    );

    // Only finals. An interim caption is rewritten every few hundred
    // milliseconds, and translating each revision would spend a request
    // per keystroke to show text that is about to change.
    final finals = event.segments.where((s) => s.isFinal && s.text.trim().isNotEmpty);
    if (finals.isEmpty) return;
    final text = finals.last.text.trim();

    state = state.copyWith(caption: text, clearTranslatedCaption: true);

    final target = state.translateTo;
    if (target == null) return;
    unawaited(_translate(text, target));
  }

  Future<void> _translate(String text, String target) async {
    try {
      final body = await api.post('/api/translate', {
        'text': text,
        'targetLang': target,
      });
      if (_disposed || state.translateTo != target) return;
      final translated = (body is Map ? body['translated'] : null) as String?;
      if (translated == null || translated.isEmpty) return;
      state = state.copyWith(
        translatedCaption: translated,
        clearTranslationError: true,
      );
    } on ApiException catch (e) {
      if (_disposed) return;
      // 503 means the server has no DeepL key; that is a deployment fact
      // rather than a transient failure, and repeating the attempt on
      // every caption would just burn requests.
      state = state.copyWith(
        translationError: e.code == 'translation_not_configured'
            ? 'Translation is not switched on for this deployment.'
            : e.message,
      );
    } catch (e) {
      if (_disposed) return;
      state = state.copyWith(translationError: '$e');
    }
  }

  /// Choose a language to translate captions into, or null to stop.
  void setTranslation(String? language) {
    state = state.copyWith(
      translateTo: language,
      clearTranslation: language == null,
      clearTranslatedCaption: true,
      clearTranslationError: true,
    );
    final caption = state.caption;
    if (language != null && caption != null) {
      unawaited(_translate(caption, language));
    }
  }

  void _onData(DataReceivedEvent event) {
    // Counted here, before anything can go wrong, because every later step
    // is a place a packet can vanish: a decode that throws, a topic that
    // does not match, a shape that is not what was expected. A counter
    // further down cannot tell "nothing arrived" from "something arrived
    // and I dropped it", and those need opposite fixes.
    final topic =
        (event.topic?.isNotEmpty ?? false) ? event.topic! : '(no topic)';
    // Also to logcat, so this can be read off a cable instead of asking
    // someone in a meeting to squint at a number on their screen.
    debugPrint('[neo-data] topic=$topic bytes=${event.data.length} '
        'from=${event.participant?.identity}');
    state = state.copyWith(
      dataPacketsSeen: state.dataPacketsSeen + 1,
      lastDataTopic: topic,
    );

    Map<String, dynamic> payload;
    try {
      payload = jsonDecode(utf8.decode(event.data)) as Map<String, dynamic>;
    } catch (e) {
      state = state.copyWith(lastDataError: 'decode failed: $e');
      return; // Never crash a meeting over one bad packet.
    }

    switch (event.topic) {
      case Topics.chat:
        final line = ChatLine.fromJson(payload);
        // Counted before the duplicate check, so the count answers "did the
        // packet arrive at all", which is the question being asked when the
        // chat looks empty.
        final seen = state.chatPacketsSeen + 1;
        if (state.chat.any((c) => c.id == line.id)) {
          state = state.copyWith(chatPacketsSeen: seen);
          return;
        }
        state = state.copyWith(
          chat: [...state.chat, line],
          unreadChat: state.unreadChat + 1,
          chatPacketsSeen: seen,
        );
      case Topics.reactions:
        final emoji = _emojiFor(payload['k'] as String?);
        if (emoji == null) return;
        state = state.copyWith(
          reactions: [...state.reactions, Reaction(emoji, DateTime.now())],
        );
      case Topics.hand:
        final id = payload['id'] as String?;
        if (id == null) return;
        final hands = Map<String, String>.from(state.raisedHands);
        if (payload['on'] == true) {
          hands[id] = payload['name'] as String? ?? 'Someone';
        } else {
          hands.remove(id);
        }
        state = state.copyWith(raisedHands: hands);
      case Topics.moderation:
        if (payload['action'] == 'delete') {
          final id = payload['messageId'];
          state = state.copyWith(
            chat: state.chat.where((c) => c.id != id).toList(),
          );
        }
    }
  }

  static String? _emojiFor(String? key) => const {
        'heart': '❤️',
        'thumbs': '👍',
        'clap': '👏',
        'laugh': '😂',
        'wow': '😮',
        'fire': '🔥',
      }[key];

  // ---- What the person in the meeting can do -----------------------------

  Future<void> toggleMic() async {
    final me = room.localParticipant;
    if (me == null) return;
    final wantOn = !me.isMicrophoneEnabled();
    await me.setMicrophoneEnabled(wantOn);
    _syncLocalMedia();

    // Turning the microphone on is the moment RECORD_AUDIO is granted, and
    // the foreground service can only claim the microphone type once it
    // has been. Restarting it here upgrades the type; without this the
    // service stays playback-only and Android may stop the capture the
    // moment the app is backgrounded.
    if (wantOn) unawaited(MeetingPresence.instance.begin(title: slug));
  }

  Future<void> toggleCamera() async {
    final me = room.localParticipant;
    if (me == null) return;
    await me.setCameraEnabled(!me.isCameraEnabled());
    _syncLocalMedia();
  }

  /// Flips between the front and back camera.
  ///
  /// Reads the position off the track rather than remembering it here: the
  /// track is restarted to switch, and a local flag would drift out of step
  /// with it the first time that restart failed.
  Future<void> switchCamera() async {
    final track = room.localParticipant?.videoTrackPublications
        .where((p) => p.source == TrackSource.camera)
        .firstOrNull
        ?.track;
    if (track is! LocalVideoTrack) return;
    final options = track.currentOptions;
    if (options is! CameraCaptureOptions) return;
    await track.setCameraPosition(
      options.cameraPosition == CameraPosition.front
          ? CameraPosition.back
          : CameraPosition.front,
    );
  }

  /// Shares the screen.
  ///
  /// Android shows its own "start recording?" consent dialog first, and the
  /// capture runs in a foreground service — declared in AndroidManifest as
  /// mediaProjection. Without the person accepting that dialog nothing is
  /// captured, which is the platform's decision, not ours.
  Future<void> toggleScreenShare() async {
    final me = room.localParticipant;
    if (me == null) return;
    await me.setScreenShareEnabled(!me.isScreenShareEnabled());
    _syncLocalMedia();
  }

  Future<void> toggleHand() async {
    final me = room.localParticipant;
    if (me == null) return;
    final raising = !state.handRaised;
    await _publish(Topics.hand, {
      'id': me.identity,
      'name': me.name.isNotEmpty ? me.name : 'Someone',
      'on': raising,
      'ts': DateTime.now().millisecondsSinceEpoch,
    }, reliable: false);
    final hands = Map<String, String>.from(state.raisedHands);
    if (raising) {
      hands[me.identity] = me.name.isNotEmpty ? me.name : 'Someone';
    } else {
      hands.remove(me.identity);
    }
    state = state.copyWith(handRaised: raising, raisedHands: hands);
  }

  Future<void> react(String key) async {
    final emoji = _emojiFor(key);
    if (emoji == null) return;
    await _publish(Topics.reactions, {'k': key}, reliable: false);
    state = state.copyWith(
      reactions: [...state.reactions, Reaction(emoji, DateTime.now())],
    );
  }

  /// Posts first, then fans out — the same order the web client uses.
  ///
  /// The server stamps the id and timestamp, so publishing the saved copy
  /// means every client agrees on them and nobody sees a duplicate when the
  /// history is reloaded.
  Future<void> sendChat(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    try {
      final body = await api.post('/api/events/$slug/chat', {'text': trimmed});
      final saved = (body is Map ? body['message'] : null) as Map<String, dynamic>?;
      if (saved == null) {
        state = state.copyWith(
          chatError: 'The server accepted the message but returned nothing.',
        );
        return;
      }
      await _publish(Topics.chat, saved, reliable: false);
      state = state.copyWith(
        chat: [...state.chat, ChatLine.fromJson(saved)],
        clearChatError: true,
      );
    } on ApiException catch (e) {
      // Reported inside the chat sheet, not as a snackbar: the sheet covers
      // the screen the snackbar would appear on, so nobody would see it.
      state = state.copyWith(
        chatError: 'Not sent (HTTP ${e.status}): ${e.message}',
      );
    } catch (e) {
      state = state.copyWith(chatError: 'Not sent: $e');
    }
  }

  /// Picks up messages the data channel could not deliver.
  ///
  /// A browser publishes chat on the reliable channel, which this app
  /// cannot receive (see _publish). Every message is persisted server-side
  /// though, so polling that history is what actually makes chat work in
  /// this direction. Merged by id, so a message that did arrive over the
  /// data channel is not shown twice.
  void _startChatPolling() {
    _chatTimer ??= Timer.periodic(
      const Duration(seconds: 4),
      (_) => unawaited(_loadChatHistory(merge: true)),
    );
  }

  Future<void> _loadChatHistory({bool merge = false}) async {
    try {
      final body = await api.get('/api/events/$slug/chat');
      final list = (body is Map ? body['messages'] : null) as List? ?? const [];
      final fetched = list
          .whereType<Map<String, dynamic>>()
          .map(ChatLine.fromJson)
          .toList();

      if (!merge) {
        state = state.copyWith(
          chat: fetched,
          unreadChat: 0,
          clearChatError: true,
        );
        return;
      }

      final known = {for (final line in state.chat) line.id};
      final added = fetched.where((line) => !known.contains(line.id)).toList();
      if (added.isEmpty) return;
      final combined = [...state.chat, ...added]
        ..sort((a, b) => a.at.compareTo(b.at));
      state = state.copyWith(
        chat: combined,
        unreadChat: state.unreadChat + added.length,
        clearChatError: true,
      );
    } on ApiException catch (e) {
      // Say so. A silently swallowed failure here looks exactly like a
      // meeting where nobody has spoken yet, which is the one thing that
      // makes this impossible to diagnose from the outside.
      state = state.copyWith(
        chatError: 'Could not load earlier messages '
            '(HTTP ${e.status}${e.code.isEmpty ? '' : ', ${e.code}'}).',
      );
    } catch (e) {
      state = state.copyWith(chatError: 'Could not load earlier messages: $e');
    }
  }

  /// Everything this app publishes goes out on the lossy channel.
  ///
  /// Not a preference — a workaround. In this LiveKit Flutter SDK (2.13.0)
  /// the reliable data channel does not work against LiveKit Cloud: a
  /// browser's reliable packets never reach this app's handler, while its
  /// lossy ones arrive fine, and the same split appears in the other
  /// direction. Two browsers talking to each other over the reliable
  /// channel work perfectly, so the fault is on this side. I could not
  /// isolate it any further from a release build, where Dart logging is
  /// stripped.
  ///
  /// Lossy delivery can drop a packet. For chat that is covered: every
  /// message is also persisted over HTTP and this app polls that history,
  /// so a dropped packet costs latency, not the message. For a raised hand
  /// it is not covered, and raising a hand again re-sends it.
  Future<void> _publish(
    String topic,
    Map<String, dynamic> payload, {
    required bool reliable,
  }) async {
    final me = room.localParticipant;
    if (me == null) {
      debugPrint('[neo-data] publish $topic skipped: no local participant');
      return;
    }
    try {
      await me.publishData(
        utf8.encode(jsonEncode(payload)),
        reliable: reliable,
        topic: topic,
      );
      debugPrint('[neo-data] published topic=$topic reliable=$reliable');
    } catch (e) {
      // A publish that fails quietly is why chat could look like a receive
      // problem when it was a send problem.
      debugPrint('[neo-data] publish topic=$topic FAILED: $e');
      rethrow;
    }
  }

  void markChatRead() => state = state.copyWith(unreadChat: 0);

  // ---- Host controls ------------------------------------------------------

  Future<void> moderate(String identity, String action) async {
    try {
      await api.post('/api/livekit/moderate', {
        'slug': slug,
        'action': action,
        'participantIdentity': identity,
      });
    } on ApiException catch (e) {
      state = state.copyWith(message: e.message);
    }
  }

  Future<void> muteEveryone() async {
    try {
      await api.post('/api/livekit/muteAll', {
        'roomName': slug,
        'exceptIdentity': room.localParticipant?.identity,
      });
      state = state.copyWith(message: 'Everyone else muted.');
    } on ApiException catch (e) {
      state = state.copyWith(message: e.message);
    }
  }

  Future<void> refreshWaitingRoom() async {
    try {
      final body = await api.get('/api/waiting-room', {'slug': slug});
      final entries = (body is Map ? body['entries'] : null) as List? ?? const [];
      state = state.copyWith(
        waitingRoom: entries
            .whereType<Map<String, dynamic>>()
            .where((e) => e['status'] == 'pending')
            .toList(),
      );
    } on ApiException {
      // Not a host, or a blip. Either way there is nothing to show.
    }
  }

  Future<void> decideWaitingRoom(String entryId, bool admit) async {
    try {
      await api.post('/api/waiting-room', {
        'op': 'decide',
        'slug': slug,
        'entryId': entryId,
        'decision': admit ? 'admit' : 'deny',
      });
      state = state.copyWith(
        waitingRoom:
            state.waitingRoom.where((e) => e['id'] != entryId).toList(),
      );
    } on ApiException catch (e) {
      state = state.copyWith(message: e.message);
    }
  }

  Future<void> toggleRecording() async {
    try {
      if (state.recordingEgressId == null) {
        final body = await api.post('/api/livekit/egress/start', {'room': slug});
        final id = (body is Map ? body['egressId'] : null) as String?;
        state = state.copyWith(
          recordingEgressId: id,
          message: id != null ? 'Recording started.' : 'Recording did not start.',
        );
      } else {
        await api.post('/api/livekit/egress/stop', {
          'egressId': state.recordingEgressId,
        });
        state = state.copyWith(
          clearRecording: true,
          message: 'Recording stopped. It will appear on the event page.',
        );
      }
    } on ApiException catch (e) {
      state = state.copyWith(message: e.message);
    }
  }

  void clearMessage() => state = state.copyWith(clearMessage: true);

  Future<void> leave() async {
    // Stop the foreground service before disconnecting, so the "you are in
    // a meeting" notification never outlives the meeting. Ending it twice
    // is harmless; leaving it running is a lie in the status bar.
    await MeetingPresence.instance.end();
    await room.disconnect();
  }

  @override
  void dispose() {
    _disposed = true;
    debugPrint('[neo-room] controller DISPOSED for $slug');
    MeetingPresence.instance.onPhoneCall.removeListener(_onPhoneCall);
    unawaited(MeetingPresence.instance.end());
    _knockTimer?.cancel();
    _hostTimer?.cancel();
    _chatTimer?.cancel();
    _weakLink.dispose();
    _reconnectWatchdog.dispose();
    _listener?.dispose();
    unawaited(room.disconnect().then((_) => room.dispose()));
    super.dispose();
  }
}

final roomControllerProvider =
    StateNotifierProvider.family.autoDispose<RoomController, RoomState, String>(
  (ref, slug) {
    final controller = RoomController(api: ref.watch(apiProvider), slug: slug);
    unawaited(controller.join());
    return controller;
  },
);
