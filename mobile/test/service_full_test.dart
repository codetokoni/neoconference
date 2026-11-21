import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/service_full.dart';

/// LiveKit refusing a join because the whole account is full only says the
/// connection failed. The app asks the server whether the service is full
/// then, and shows "Meeting full" instead of "Could not join".
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  const full = 'This meeting is full right now: the most people we can connect '
      'at once are already connected. Please try again in a few minutes.';

  ApiClient api(Object? capacity, {int status = 200, List<String>? asked}) => ApiClient(
        token: () async => 'jwt',
        http_: MockClient((req) async {
          asked?.add(req.url.path);
          switch (req.url.path) {
            case '/api/livekit/capacity':
              if (capacity is Exception) throw capacity;
              return http.Response(jsonEncode(capacity), status);
            case '/api/events/role':
              return http.Response(jsonEncode({'role': 'attendee'}), 200);
            case '/api/livekit/token':
              // Let in, to a LiveKit that is not there: the connection fails
              // as a refused one does.
              return http.Response(jsonEncode({'token': 'lk', 'wsUrl': 'ws://127.0.0.1:9'}), 200);
          }
          return http.Response('{}', 404);
        }),
      );

  group('asking whether the service is full', () {
    test('full: the server\'s message', () async {
      expect(await serviceFullMessage(api({'full': true, 'message': full})), full);
    });

    test('full with no message: a plain one', () async {
      expect(await serviceFullMessage(api({'full': true})), serviceFullFallback);
    });

    test('not full, refused, unreachable or nonsense: null', () async {
      expect(await serviceFullMessage(api({'full': false})), isNull);
      expect(await serviceFullMessage(api({'error': 'unauthenticated'}, status: 401)), isNull);
      expect(await serviceFullMessage(api(Exception('offline'))), isNull);
      expect(await serviceFullMessage(api(['full'])), isNull);
      expect(await serviceFullMessage(api({'full': 'true'})), isNull);
    });
  });

  group('a join LiveKit refuses', () {
    Future<RoomController> joinWith(ApiClient client) async {
      final c = RoomController(api: client, slug: 'big');
      await c.nameConfirmed();
      return c;
    }

    test('with the service full: Meeting full, and the server\'s words', () async {
      final asked = <String>[];
      final c = await joinWith(api({'full': true, 'message': full}, asked: asked));
      expect(asked, contains('/api/livekit/token'), reason: 'it was let in first');
      expect(c.state.phase, JoinPhase.full);
      expect(c.state.message, full);
      c.dispose();
    });

    test('otherwise: Could not join, as before', () async {
      final c = await joinWith(api({'full': false}));
      expect(c.state.phase, JoinPhase.failed);
      expect(c.state.message, startsWith('Could not join.'));
      c.dispose();
    });
  });
}
