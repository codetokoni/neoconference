import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/room/room_controller.dart';

void main() {
  group('ApiException', () {
    test('carries the machine-readable reason, not just a sentence', () {
      const e = ApiException(
        status: 403,
        message: 'waiting_room',
        body: {'error': 'waiting_room', 'status': 'pending'},
      );
      expect(e.code, 'waiting_room');
      expect(e.body['status'], 'pending');
    });

    test('a 403 does not mean the session is bad', () {
      // The join route answers 403 for a locked or full room. Treating that
      // as a dead session would sign the person out for walking up to a
      // meeting that had not started.
      const locked = ApiException(status: 403, message: 'meeting_locked');
      const stale = ApiException(status: 401, message: 'unauthenticated');
      expect(locked.isUnauthenticated, isFalse);
      expect(stale.isUnauthenticated, isTrue);
    });
  });

  group('NeoEvent', () {
    test('reads the fields /api/events/mine actually sends', () {
      final event = NeoEvent.fromJson(const {
        'id': 'evt_1',
        'slug': 'sunday-service',
        'name': 'Sunday Service',
        'state': 'live',
        'isPermanent': false,
        'isLocked': false,
        'waitingRoomEnabled': true,
        'startedAt': '2026-09-24T09:00:00.000Z',
      });
      expect(event.slug, 'sunday-service');
      expect(event.name, 'Sunday Service');
      expect(event.isLive, isTrue);
      expect(event.waitingRoomEnabled, isTrue);
      expect(event.startedAt, isNotNull);
    });

    test('a nameless event still has something to tap', () {
      final event = NeoEvent.fromJson(const {'slug': 'x', 'name': '  '});
      expect(event.name, 'Untitled meeting');
    });

    test('an ended meeting is not joinable, but a personal room always is', () {
      final ended = NeoEvent.fromJson(const {'slug': 'a', 'state': 'ended'});
      final personal = NeoEvent.fromJson(
        const {'slug': 'b', 'state': 'ended', 'isPermanent': true},
      );
      expect(ended.canJoin, isFalse);
      expect(personal.canJoin, isTrue);
    });
  });

  group('room protocol', () {
    test('topics match the web client', () {
      // If these drift, this app and every browser in the same meeting stop
      // hearing each other, with no error anywhere.
      expect(Topics.chat, 'neo-chat');
      expect(Topics.typing, 'neo-typing');
      expect(Topics.moderation, 'neo-mod');
      expect(Topics.reactions, 'neo-reactions');
      expect(Topics.hand, 'neo-hand');
    });

    test('a chat line survives a message with no id', () {
      // The web client stamps an id server-side, but a direct message is
      // published straight over the data channel and may arrive without one.
      final line = ChatLine.fromJson(const {
        'userId': 'user_1',
        'ts': '2026-09-24T09:15:00.000Z',
        'name': 'Ada',
        'text': 'hello',
        'toUserId': 'user_2',
      });
      expect(line.id, isNotEmpty);
      expect(line.isDirect, isTrue);
      expect(line.text, 'hello');
    });

    test('a chat line with a broken timestamp still shows', () {
      final line = ChatLine.fromJson(const {'name': 'Ada', 'text': 'hi'});
      expect(line.at, isNotNull);
      expect(line.text, 'hi');
    });
  });

  group('RoomState', () {
    test('only a host or co-host sees host controls', () {
      for (final role in ['host', 'cohost']) {
        expect(RoomState(role: role).canManage, isTrue, reason: role);
      }
      for (final role in ['speaker', 'viewer', 'attendee', 'guest']) {
        expect(RoomState(role: role).canManage, isFalse, reason: role);
      }
    });

    test('clearing a message actually clears it', () {
      // copyWith's null-means-keep rule would otherwise make a cleared
      // message reappear, which is why the flag exists.
      const state = RoomState(message: 'Everyone else muted.');
      expect(state.copyWith(micOn: true).message, 'Everyone else muted.');
      expect(state.copyWith(clearMessage: true).message, isNull);
    });

    test('stopping a recording clears the egress id', () {
      const recording = RoomState(recordingEgressId: 'EG_123');
      expect(recording.isRecording, isTrue);
      expect(recording.copyWith(clearRecording: true).isRecording, isFalse);
    });
  });
}
