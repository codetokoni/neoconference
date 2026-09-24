import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../core/api_client.dart';
import '../events/event.dart';

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
    bool clearMessage = false,
    bool clearRecording = false,
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
      );
}

/// Joining a meeting and everything that happens inside it.
///
/// The server decides who may do what; this asks and reports. Nothing here
/// grants a permission locally — a viewer's microphone button is absent
/// because LiveKit refuses the publish, not because the app hid it.
class RoomController extends StateNotifier<RoomState> {
  RoomController({required this.api, required this.slug}) : super(const RoomState());

  final ApiClient api;
  final String slug;

  final room = Room(
    roomOptions: const RoomOptions(
      adaptiveStream: true,
      // A phone on mobile data should send fewer layers, not choke.
      dynacast: true,
    ),
  );

  EventsListener<RoomEvent>? _listener;
  Timer? _knockTimer;
  Timer? _hostTimer;
  bool _disposed = false;

  Future<void> join() async {
    state = state.copyWith(phase: JoinPhase.connecting, clearMessage: true);
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

  Future<void> _resolveRole() async {
    try {
      final body = await api.get('/api/events/role', {'slug': slug});
      final role = (body is Map ? body['role'] : null) as String?;
      if (role != null) state = state.copyWith(role: role);
    } on ApiException {
      // Role is a convenience for showing host controls. The server checks
      // it again on every action, so failing to read it is not fatal.
    }
  }

  /// Asks for a LiveKit token. Returns null when a gate answered instead,
  /// having already moved the state to the right waiting screen.
  Future<Map<String, dynamic>?> _token() async {
    final body = await api.get('/api/livekit/token', {'room': slug, 'event': slug});
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
    _listener = room.createListener();
    _wireEvents();
    await room.connect(wsUrl, token);
    state = state.copyWith(phase: JoinPhase.connected, clearMessage: true);

    // Join muted with the camera off. Arriving already broadcasting is a
    // rude surprise on a phone, which is likely to be somewhere personal.
    await _loadChatHistory();
    if (state.canManage) unawaited(refreshWaitingRoom());
  }

  void _wireEvents() {
    _listener!
      ..on<DataReceivedEvent>(_onData)
      ..on<RoomDisconnectedEvent>((e) {
        if (_disposed) return;
        state = state.copyWith(
          phase: JoinPhase.failed,
          message: 'Disconnected from the meeting.',
        );
      })
      // Mute events arrive for everyone, not just this device. Syncing our
      // own buttons is enough to redraw someone else's microphone icon too:
      // every state write is a new object, and StateNotifier notifies on
      // identity, so the participant list rebuilds from the same write.
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

  void _onData(DataReceivedEvent event) {
    Map<String, dynamic> payload;
    try {
      payload = jsonDecode(utf8.decode(event.data)) as Map<String, dynamic>;
    } catch (_) {
      return; // Not ours, or malformed. Never crash a meeting over a packet.
    }

    switch (event.topic) {
      case Topics.chat:
        final line = ChatLine.fromJson(payload);
        if (state.chat.any((c) => c.id == line.id)) return;
        state = state.copyWith(
          chat: [...state.chat, line],
          unreadChat: state.unreadChat + 1,
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
    await me.setMicrophoneEnabled(!me.isMicrophoneEnabled());
    _syncLocalMedia();
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
    }, reliable: true);
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
      if (saved == null) return;
      await _publish(Topics.chat, saved, reliable: true);
      state = state.copyWith(chat: [...state.chat, ChatLine.fromJson(saved)]);
    } on ApiException catch (e) {
      state = state.copyWith(message: 'Message not sent: ${e.message}');
    }
  }

  Future<void> _loadChatHistory() async {
    try {
      final body = await api.get('/api/events/$slug/chat');
      final list = (body is Map ? body['messages'] : null) as List? ?? const [];
      state = state.copyWith(
        chat: list
            .whereType<Map<String, dynamic>>()
            .map(ChatLine.fromJson)
            .toList(),
        unreadChat: 0,
      );
    } on ApiException {
      // An empty history is better than refusing to show the room.
    }
  }

  Future<void> _publish(
    String topic,
    Map<String, dynamic> payload, {
    required bool reliable,
  }) async {
    final me = room.localParticipant;
    if (me == null) return;
    await me.publishData(
      utf8.encode(jsonEncode(payload)),
      reliable: reliable,
      topic: topic,
    );
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
    await room.disconnect();
  }

  @override
  void dispose() {
    _disposed = true;
    _knockTimer?.cancel();
    _hostTimer?.cancel();
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
