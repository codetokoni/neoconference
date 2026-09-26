import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/room/chat_poller.dart';
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

  group('plan gate', () {
    test('a 402 upgrade refusal is distinguishable from a bad request', () {
      // The create screen offers the upgrade sheet on exactly this shape.
      // A plain 400 must not open it, and this must not be mistaken for a
      // dead session — 402 is the server saying "your plan", not "who are
      // you".
      const refused = ApiException(
        status: 402,
        message: 'Live translation is available on the Pro plan and above.',
        body: {
          'error': 'plan_upgrade_required',
          'feature': 'translation',
          'plan': 'free',
        },
      );
      expect(refused.code, 'plan_upgrade_required');
      expect(refused.body['plan'], 'free');
      expect(refused.isUnauthenticated, isFalse);

      const badRequest = ApiException(status: 400, message: 'name_required');
      expect(badRequest.code, isNot('plan_upgrade_required'));
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

  group('chat merge', () {
    // The app receives the same message twice by design: once over the data
    // channel when that works, and again from the polled history that exists
    // because it often does not. Showing it twice would be the obvious way
    // for that workaround to go wrong.
    ChatLine line(String id, int minute) => ChatLine.fromJson({
          'id': id,
          'name': 'Ada',
          'text': id,
          'ts': '2026-09-24T09:${minute.toString().padLeft(2, '0')}:00.000Z',
        });

    List<ChatLine> merge(List<ChatLine> have, List<ChatLine> fetched) {
      final known = {for (final l in have) l.id};
      final added = fetched.where((l) => !known.contains(l.id)).toList();
      if (added.isEmpty) return have;
      return [...have, ...added]..sort((a, b) => a.at.compareTo(b.at));
    }

    test('a message already seen live is not added again', () {
      final have = [line('a', 1), line('b', 2)];
      final merged = merge(have, [line('a', 1), line('b', 2)]);
      expect(merged.map((l) => l.id), ['a', 'b']);
    });

    test('a message only the history has is added', () {
      final merged = merge([line('a', 1)], [line('a', 1), line('b', 2)]);
      expect(merged.map((l) => l.id), ['a', 'b']);
    });

    test('a late arrival lands in time order, not at the end', () {
      // The data channel can deliver a newer message before the poll returns
      // an older one, so appending blindly would show them out of order.
      final merged = merge([line('c', 3)], [line('a', 1), line('c', 3)]);
      expect(merged.map((l) => l.id), ['a', 'c']);
    });
  });

  group('waiting room', () {
    // A host already in the meeting was never told anyone had knocked: the
    // list was fetched only on joining, and the button that opens it only
    // appears once it has someone in it.
    Map<String, dynamic> knock(String id, [String? name]) =>
        {'id': id, 'name': name ?? id, 'status': 'pending'};

    test('a new knock is announced by name', () {
      expect(newKnockMessage(const [], [knock('u1', 'streamlab')]),
          'streamlab is waiting to join.');
    });

    test('someone already waiting is not announced again', () {
      final waiting = [knock('u1')];
      expect(newKnockMessage(waiting, [knock('u1')]), isNull);
    });

    test('someone leaving the list is not news', () {
      expect(newKnockMessage([knock('u1'), knock('u2')], [knock('u2')]), isNull);
    });

    test('same count, different person, is still a new knock', () {
      expect(newKnockMessage([knock('u1', 'Ada')], [knock('u2', 'Bo')]),
          'Bo is waiting to join.');
    });

    test('several at once are counted, and a blank name still reads', () {
      expect(newKnockMessage(const [], [knock('a'), knock('b')]),
          '2 people are waiting to join.');
      expect(newKnockMessage(const [], [knock('a', ' ')]),
          'Someone is waiting to join.');
    });

    test('the host polls at the web room\'s pace, slower when away', () {
      expect(waitingPollInterval(chatOpen: false, visible: true),
          const Duration(seconds: 4));
      expect(waitingPollInterval(chatOpen: false, visible: false),
          const Duration(seconds: 30));
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

    test('a dead link is never reported as a live meeting', () {
      // Found on a real phone: the signal socket dropped and retried for
      // minutes while the header still read "2 in the meeting". A stale
      // participant count is worse than no count, because someone acts on
      // it — they keep talking into a call that ended.
      const live = RoomState(phase: JoinPhase.connected);
      expect(live.link, RoomLink.live);
      expect(live.copyWith(link: RoomLink.reconnecting).link,
          RoomLink.reconnecting);
      expect(live.copyWith(link: RoomLink.lost).link, RoomLink.lost);
    });

    test('stopping a recording clears the egress id', () {
      const recording = RoomState(recordingEgressId: 'EG_123');
      expect(recording.isRecording, isTrue);
      expect(recording.copyWith(clearRecording: true).isRecording, isFalse);
    });

    test('a recording started on another device is shown here too', () {
      // On the phone, a recording started from another device ran for over
      // two minutes with nothing in the header: only the egress id was
      // checked, and only the starting device has it.
      const elsewhere = RoomState(roomRecording: true);
      expect(elsewhere.isRecording, isTrue);
      expect(elsewhere.recordingHere, isFalse,
          reason: 'cannot be stopped from here, and must not start another');
    });

    test('the device that started it can stop it', () {
      const here = RoomState(recordingEgressId: 'EG_123', roomRecording: true);
      expect(here.isRecording, isTrue);
      expect(here.recordingHere, isTrue);
    });
  });
}
