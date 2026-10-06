import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../auth/auth_controller.dart';
import '../auth/clerk_client.dart';
import '../core/api_client.dart';
import 'incoming_call.dart';

/// Group calls and meeting notices reaching the phone when the app is
/// closed or the screen is locked: Firebase Cloud Messaging.
///
/// The server sends data-only messages (src/lib/fcmStore.ts) carrying the
/// same payload a browser's push gets. From them the app draws:
///
///  - a **ring**: a call notification on the "calls" channel — full-screen
///    over the lock screen where Android allows, the phone's ringtone
///    looping until it is answered, declined or 45 s pass, with Answer and
///    Decline. Tapping it (or the screen waking for it) opens the in-app
///    incoming-call screen, which takes over the ringing.
///  - anything else (a reminder, an invite, a mention): an ordinary
///    notification on the "meetings" channel that opens the group or
///    meeting it is about. The server sends these with a notification
///    block, so with the app in the background Android shows them itself
///    — app code run for them waits out Battery Saver — and this only
///    handles the tap.
///
/// With the app open, a ring goes straight to the in-app call screen, and
/// a notice is shown here (Android shows none for an app in front).
class CallPush {
  CallPush._();

  static final instance = CallPush._();

  static const callsChannel = 'calls';
  static const meetingsChannel = 'meetings';

  /// Whether start-up finished and pushes work; awaited by everything else.
  /// The signed-in screen asks to register on its first frame, before
  /// Firebase has finished starting — registering then failed with "no
  /// Firebase App", which is why this is a future and not a flag.
  Future<bool>? _ready;
  String? _registeredToken;
  StreamSubscription<String>? _refresh;

  /// Firebase and the notification channels, and listening for pushes and
  /// taps. Called once from main(); a phone without Google Play services
  /// (or a build without google-services.json) carries on without pushes.
  Future<bool> start() => _ready ??= _start();

  Future<bool> _start() async {
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(callPushBackgroundMessage);
      await _initNotifications(onTap: _onTap);
      FirebaseMessaging.onMessage.listen(_onForegroundMessage);
      IncomingCalls.instance.onScreenShown = (ring) => unawaited(cancelRing(ring));
      // Launched by tapping one of our notifications.
      final launch = await _plugin.getNotificationAppLaunchDetails();
      final response = launch?.notificationResponse;
      if (launch?.didNotificationLaunchApp == true && response != null) _onTap(response);
      // A notice Android showed by itself (see fcmNotice on the server),
      // tapped while the app was closed, or in the background.
      final opened = await FirebaseMessaging.instance.getInitialMessage();
      if (opened != null) _onNoticeOpened(opened);
      FirebaseMessaging.onMessageOpenedApp.listen(_onNoticeOpened);
      return true;
    } catch (e) {
      debugPrint('[push] start: $e');
      return false;
    }
  }

  /// Registers this phone for the signed-in person's pushes, and again
  /// whenever Firebase gives it a new token.
  Future<void> register(ApiClient api) async {
    final ready = _ready;
    if (ready == null || !await ready) return;
    try {
      await FirebaseMessaging.instance.requestPermission();
      await _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _send(api, token);
      await _refresh?.cancel();
      _refresh = FirebaseMessaging.instance.onTokenRefresh.listen((t) => unawaited(_send(api, t)));
    } catch (e) {
      debugPrint('[push] register: $e');
    }
  }

  Future<void> _send(ApiClient api, String token) async {
    if (token == _registeredToken) return;
    try {
      await api.post('/api/push/fcm', {'token': token});
      _registeredToken = token;
      debugPrint('[push] registered');
    } catch (e) {
      // 503 until the server has its Firebase key; tried again next start.
      debugPrint('[push] register token: $e');
    }
  }

  /// Signing out: this phone's token is thrown away, so the server's next
  /// push to it fails as unregistered and it is forgotten there too. No
  /// signed-in request is needed, which there no longer is.
  Future<void> unregister() async {
    final ready = _ready;
    if (ready == null || !await ready) return;
    await _refresh?.cancel();
    _refresh = null;
    _registeredToken = null;
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (e) {
      debugPrint('[push] unregister: $e');
    }
  }

  void _onForegroundMessage(RemoteMessage message) {
    final data = message.data;
    final ring = IncomingRing.from(data, DateTime.now());
    if (ring != null) {
      IncomingCalls.instance.add(RingArrived(ring));
    } else if (data['type'] != 'ring') {
      unawaited(showNotice(data));
    }
  }

  void _onNoticeOpened(RemoteMessage message) {
    final url = message.data['url'];
    if (url is String) {
      IncomingCalls.instance.add(NoticeTapped(url: url, groupId: message.data['groupId'] as String?));
    }
  }

  /// A notification (or one of its buttons) was tapped with the app able
  /// to show itself.
  void _onTap(NotificationResponse response) {
    final data = _decode(response.payload);
    if (data == null) return;
    final ring = IncomingRing.from(data, DateTime.now());
    if (ring != null) {
      if (response.actionId == declineAction) return; // handled in the background
      IncomingCalls.instance.add(RingArrived(ring, answerNow: response.actionId == answerAction));
      return;
    }
    if (data['type'] == 'ring') return; // expired while it sat there
    final url = data['url'];
    if (url is String) {
      IncomingCalls.instance.add(NoticeTapped(url: url, groupId: data['groupId'] as String?));
    }
  }
}

const answerAction = 'answer';
const declineAction = 'decline';

final _plugin = FlutterLocalNotificationsPlugin();

Map<String, dynamic>? _decode(String? payload) {
  if (payload == null || payload.isEmpty) return null;
  try {
    final v = jsonDecode(payload);
    return v is Map<String, dynamic> ? v : null;
  } catch (_) {
    return null;
  }
}

Future<void> _initNotifications({void Function(NotificationResponse)? onTap}) async {
  await _plugin.initialize(
    settings: const InitializationSettings(android: AndroidInitializationSettings('ic_stat_call')),
    onDidReceiveNotificationResponse: onTap,
    onDidReceiveBackgroundNotificationResponse: callPushNotificationAction,
  );
  final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await android?.createNotificationChannel(const AndroidNotificationChannel(
    CallPush.callsChannel,
    'Group calls',
    description: 'A group meeting calling you, like a phone call.',
    importance: Importance.max,
    sound: UriAndroidNotificationSound('content://settings/system/ringtone'),
    audioAttributesUsage: AudioAttributesUsage.notificationRingtone,
  ));
  await android?.createNotificationChannel(const AndroidNotificationChannel(
    CallPush.meetingsChannel,
    'Meetings',
    description: 'Reminders, invitations and mentions from your groups.',
    importance: Importance.high,
  ));
}

/// A stable notification id for a meeting, so a newer push replaces an
/// older one for the same meeting (as the web's tag does).
int notificationIdFor(String key) {
  var h = 0;
  for (final c in key.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return h;
}

/// Android's FLAG_INSISTENT: the sound repeats until the notification goes.
const _insistent = 4;

/// The call notification for [ring], as the server's payload [data].
Future<void> showRing(IncomingRing ring, Map<String, dynamic> data) async {
  final left = ring.expiresAt.difference(DateTime.now()).inMilliseconds;
  if (left <= 0) return;
  final who = ring.caller.isEmpty ? 'Incoming call' : '${ring.caller} is calling';
  await _plugin.show(
    id: notificationIdFor(ring.eventSlug),
    title: ring.meetingTitle.isEmpty ? 'Group call' : ring.meetingTitle,
    body: ring.groupName.isEmpty ? who : '$who · ${ring.groupName}',
    payload: jsonEncode(data),
    notificationDetails: NotificationDetails(
      android: AndroidNotificationDetails(
        CallPush.callsChannel,
        'Group calls',
        importance: Importance.max,
        priority: Priority.max,
        category: AndroidNotificationCategory.call,
        fullScreenIntent: true,
        ongoing: true,
        autoCancel: false,
        visibility: NotificationVisibility.public,
        timeoutAfter: left,
        audioAttributesUsage: AudioAttributesUsage.notificationRingtone,
        sound: const UriAndroidNotificationSound('content://settings/system/ringtone'),
        vibrationPattern: Int64List.fromList([0, 1000, 1000, 1000, 1000, 1000]),
        additionalFlags: Int32List.fromList([_insistent]),
        actions: const [
          AndroidNotificationAction(declineAction, 'Decline', cancelNotification: true),
          AndroidNotificationAction(answerAction, 'Answer', showsUserInterface: true, cancelNotification: true),
        ],
      ),
    ),
  );
}

Future<void> cancelRing(IncomingRing ring) => _plugin.cancel(id: notificationIdFor(ring.eventSlug));

/// Any other push as an ordinary notification.
Future<void> showNotice(Map<String, dynamic> data) async {
  final title = data['title'];
  if (title is! String || title.isEmpty) return;
  final raw = data['expiresAt'];
  final expires = raw is String ? int.tryParse(raw) : (raw is num ? raw.toInt() : null);
  if (expires != null && expires <= DateTime.now().millisecondsSinceEpoch) return;
  await _plugin.show(
    id: notificationIdFor('${data['type']}:${data['eventSlug'] ?? data['groupId'] ?? title}'),
    title: title,
    body: data['body'] as String?,
    payload: jsonEncode(data),
    notificationDetails: const NotificationDetails(
      android: AndroidNotificationDetails(
        CallPush.meetingsChannel,
        'Meetings',
        importance: Importance.high,
        priority: Priority.high,
        category: AndroidNotificationCategory.event,
      ),
    ),
  );
}

/// A push arriving while the app is not in front (in its own isolate).
@pragma('vm:entry-point')
Future<void> callPushBackgroundMessage(RemoteMessage message) async {
  // A notice Android already showed by itself: another would be a copy.
  if (message.notification != null) return;
  try {
    await Firebase.initializeApp();
    await _initNotifications();
    final data = message.data;
    final ring = IncomingRing.from(data, DateTime.now());
    if (ring != null) {
      await showRing(ring, data);
    } else if (data['type'] != 'ring') {
      await showNotice(data);
    }
  } catch (e) {
    debugPrint('[push] background: $e');
  }
}

/// Decline pressed on a call notification, without opening the app (in
/// its own isolate): tells the server, as the web's Decline does, so this
/// person is not rung again for that meeting.
@pragma('vm:entry-point')
Future<void> callPushNotificationAction(NotificationResponse response) async {
  if (response.actionId != declineAction) return;
  final data = _decode(response.payload);
  if (data == null) return;
  final ring = IncomingRing.from(data, DateTime.now());
  if (ring == null) return;
  final prefs = await SharedPreferences.getInstance();
  final session = prefs.getString(AuthController.sessionKey);
  if (session == null) return;
  // Signed in from what the app saved: the session and Clerk's client
  // cookie. This isolate has no AuthController of its own.
  final clerk = ClerkClient()..clientCookie = prefs.getString(AuthController.cookieKey);
  final api = ApiClient(token: () => clerk.sessionToken(session));
  try {
    await RingResponder(api).respond(ring, answer: false);
  } finally {
    api.close();
    clerk.close();
  }
}
