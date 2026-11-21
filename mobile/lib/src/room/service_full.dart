import '../core/api_client.dart';

/// What the "Meeting full" screen says when the whole service is full and no
/// message came with the answer.
const serviceFullFallback =
    'This meeting is full right now. Please try again in a few minutes.';

/// Whether a connection LiveKit just refused was the whole service being
/// full: the server's message if so, null otherwise or when it cannot say.
///
/// The token route turns joins away once the LiveKit account is full, but
/// its count is a few seconds old, so LiveKit itself can still refuse
/// someone it let in, and LiveKit only says the connection failed. Asked
/// right then, `/api/livekit/capacity` says whether that was a full meeting.
/// Never throws, and gives up after a few seconds.
Future<String?> serviceFullMessage(ApiClient api) async {
  try {
    final body = await api
        .get('/api/livekit/capacity')
        .timeout(const Duration(seconds: 4));
    if (body is Map && body['full'] == true) {
      final m = body['message'];
      return m is String && m.trim().isNotEmpty ? m : serviceFullFallback;
    }
  } catch (_) {
    // Could not ask: the join simply failed, as it says.
  }
  return null;
}
