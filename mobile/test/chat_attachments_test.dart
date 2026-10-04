import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/room_widgets.dart';

/// Asked for: the app's chat had no way to send a file. The website's chat
/// already did, through /api/chat/upload; the app now uses the same.
void main() {
  test('a message with a file reads its attachment, as the web sends it', () {
    final line = ChatLine.fromJson({
      'id': 'm1',
      'name': 'Grace',
      'text': '',
      'ts': '2026-10-04T19:00:00.000Z',
      'attachments': [
        {'url': 'https://r2/x.pdf', 'name': 'Agenda.pdf', 'mimeType': 'application/pdf', 'size': 250000, 'kind': 'file'},
        {'url': 'https://r2/y.jpg', 'name': 'photo.jpg', 'mimeType': 'image/jpeg', 'size': 2400000, 'kind': 'image'},
        {'name': 'no url, ignored'},
      ],
    });
    expect(line.attachments, hasLength(2));
    expect(line.attachments.first.name, 'Agenda.pdf');
    expect(line.attachments.first.isImage, isFalse);
    expect(line.attachments.first.sizeLabel, '245 KB');
    expect(line.attachments.last.isImage, isTrue);
    expect(line.attachments.last.sizeLabel, '2.3 MB');
    // A message without files still reads as before.
    expect(ChatLine.fromJson({'id': 'm2', 'text': 'hi'}).attachments, isEmpty);
  });

  test('only what the upload route accepts is sent', () {
    expect(chatMimeType('Agenda.PDF'), 'application/pdf');
    expect(chatMimeType('photo.jpeg'), 'image/jpeg');
    expect(chatMimeType('sheet.xlsx'), contains('spreadsheetml'));
    expect(chatMimeType('setup.exe'), isNull);
    expect(chatMimeType('noextension'), isNull);
  });

  test('the upload is multipart with a "file" field of the right type', () async {
    late http.Request seen;
    final api = ApiClient(
      token: () async => 'jwt',
      http_: MockClient((req) async {
        seen = req;
        return http.Response(
          jsonEncode({
            'ok': true,
            'attachment': {'url': 'https://r2/a.pdf', 'name': 'a.pdf', 'mimeType': 'application/pdf', 'size': 3, 'kind': 'file'},
          }),
          200,
        );
      }),
    );

    final body = await api.postFile('/api/chat/upload', bytes: [1, 2, 3], filename: 'a.pdf', mimeType: 'application/pdf');

    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/chat/upload');
    expect(seen.headers['authorization'], 'Bearer jwt');
    expect(seen.headers['content-type'], startsWith('multipart/form-data'));
    final raw = latin1.decode(seen.bodyBytes);
    expect(raw, contains('name="file"; filename="a.pdf"'));
    expect(raw, contains('content-type: application/pdf'));
    expect(ChatAttachment.fromJson(body['attachment'] as Map<String, dynamic>)?.url, 'https://r2/a.pdf');
  });

  testWidgets('a file shows as a card with its name and size', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ChatAttachmentView(
          attachment: ChatAttachment(
            url: 'https://r2/x.pdf',
            name: 'Agenda.pdf',
            mimeType: 'application/pdf',
            size: 250000,
            isImage: false,
          ),
        ),
      ),
    ));
    expect(find.text('Agenda.pdf'), findsOneWidget);
    expect(find.text('245 KB · tap to open'), findsOneWidget);
    expect(find.byIcon(Icons.picture_as_pdf_outlined), findsOneWidget);
  });
}
