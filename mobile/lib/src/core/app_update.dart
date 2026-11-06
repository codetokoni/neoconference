import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart' show apiProvider;
import 'config.dart';

/// A newer NeoConference on the LoveWorld AppStore than this one, from
/// GET /api/app/latest (src/lib/appRelease.ts). A meeting link opens
/// whatever app is installed, so the app has to say when it is out of date;
/// before 1.2.5 nothing did, and people stayed on old versions.
@immutable
class AppUpdate {
  const AppUpdate({required this.current, required this.latest, required this.storeUrl, this.required = false});
  final String current;
  final String latest;
  final String storeUrl;

  /// This version is below the site's minimum (minVersion): it can no longer
  /// join meetings, so the pop-up has no Later.
  final bool required;
}

/// Where to update: `<site>/download`, which opens the app's page on the
/// LoveWorld AppStore, so every download is counted there.
String get kAppUpdateUrl => '${Config.site}/download';

/// How the store page is opened; a test replaces it.
Future<void> Function(String url) launchAppUpdate =
    (url) => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);

/// Opens the store page to update (sign in with KingsChat, tap Download).
Future<void> openAppUpdate([String? url]) => launchAppUpdate(url ?? kAppUpdateUrl);

/// -1, 0 or 1, comparing dotted versions ("1.2.10" > "1.2.9").
int compareAppVersions(String a, String b) {
  final pa = a.split('.').map((n) => int.tryParse(n) ?? 0).toList();
  final pb = b.split('.').map((n) => int.tryParse(n) ?? 0).toList();
  for (var i = 0; i < (pa.length > pb.length ? pa.length : pb.length); i++) {
    final d = (i < pa.length ? pa[i] : 0) - (i < pb.length ? pb[i] : 0);
    if (d != 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/// Null when this app is up to date, or the check could not be made.
final appUpdateProvider = FutureProvider<AppUpdate?>((ref) async {
  try {
    final info = await PackageInfo.fromPlatform();
    final body = await ref.read(apiProvider).get('/api/app/latest');
    // Also where the website and sign-in are now (see Config).
    await Config.adopt(body);
    if (body is! Map) return null;
    final latest = body['latestVersion'];
    final url = body['updateUrl'] ?? body['storeUrl'];
    if (latest is! String || url is! String) return null;
    if (compareAppVersions(info.version, latest) >= 0) return null;
    final minimum = body['minVersion'];
    return AppUpdate(
      current: info.version,
      latest: latest,
      storeUrl: url,
      required: minimum is String && compareAppVersions(info.version, minimum) < 0,
    );
  } catch (_) {
    return null;
  }
});

/// How long the app must have been away before "Update available" is said
/// again. Coming back from a quick look at WhatsApp is not the moment;
/// opening the app again later in the day is.
const kUpdateAskAgainAfter = Duration(minutes: 30);

/// The clock the gate reads; a test moves it.
@visibleForTesting
DateTime Function() appUpdateClock = DateTime.now;

/// Says when a newer app is on the store, on every screen from the first one
/// (signed out too: the sign-in screen is where an old app is opened most).
///
/// - Asked when the app starts, and again each time it comes back to the
///   front, so an app left running for days still hears of a release.
/// - "Update available" can be put off (Later), and is said again only after
///   the app has been away for [kUpdateAskAgainAfter].
/// - Below the site's minimum the app cannot join meetings any more, so it
///   says "Update required" with no Later, and says it again on every return
///   until the app is updated (or the minimum is lowered).
///
/// Before 1.2.11 the pop-up lived on Home only, once per run: signed-out
/// people never saw it, and nothing ever had to be updated.
class AppUpdateGate extends ConsumerStatefulWidget {
  const AppUpdateGate({super.key, required this.child});
  final Widget child;

  @override
  ConsumerState<AppUpdateGate> createState() => _AppUpdateGateState();
}

class _AppUpdateGateState extends ConsumerState<AppUpdateGate> with WidgetsBindingObserver {
  DateTime? _lastAsked;
  DateTime? _awaySince;
  bool _open = false;
  bool _openRequired = false;
  NavigatorState? _navigator;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ref.listenManual<AsyncValue<AppUpdate?>>(appUpdateProvider, (_, next) {
      if (next.isLoading) return;
      _consider(next.valueOrNull);
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      _awaySince ??= appUpdateClock();
    } else if (state == AppLifecycleState.resumed && _awaySince != null) {
      final away = appUpdateClock().difference(_awaySince!);
      _awaySince = null;
      // Long enough away: the next answer may be said again.
      if (away >= kUpdateAskAgainAfter) _lastAsked = null;
      ref.invalidate(appUpdateProvider);
    }
  }

  void _consider(AppUpdate? update) {
    // The minimum was lowered (or the app updated) while it was showing.
    if (_open && _openRequired && (update == null || !update.required)) {
      _navigator?.pop();
      return;
    }
    if (update == null || _open) return;
    if (!update.required && _lastAsked != null) return;
    _lastAsked = appUpdateClock();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _open) return;
      _show(update);
    });
    // The answer arrives with nothing to redraw: a still screen (the welcome
    // page, seen on the emulator) draws no next frame, so the callback above
    // waited for ever and the pop-up never came. Ask for that frame.
    WidgetsBinding.instance.scheduleFrame();
  }

  Future<void> _show(AppUpdate u) async {
    _open = true;
    _openRequired = u.required;
    _navigator = Navigator.of(context);
    await showDialog<void>(
      context: context,
      barrierDismissible: !u.required,
      builder: (dialogContext) => PopScope(
        canPop: !u.required,
        child: AlertDialog(
          icon: const Icon(Icons.system_update_rounded),
          title: Text(u.required ? 'Update required' : 'Update available'),
          content: Text(
            u.required
                ? 'This version of NeoLinguaMeet (${u.current}) can no longer join meetings. '
                    'Update to ${u.latest} on the LoveWorld AppStore: sign in with KingsChat and tap Download.'
                : 'NeoLinguaMeet ${u.latest} is ready (you have ${u.current}). '
                    'On the LoveWorld AppStore, sign in with KingsChat and tap Download.',
          ),
          actions: [
            if (!u.required) TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Later')),
            FilledButton(
              onPressed: () {
                // Required: it stays up behind the store, for when they come back.
                if (!u.required) Navigator.pop(dialogContext);
                openAppUpdate(u.storeUrl);
              },
              child: const Text('Update'),
            ),
          ],
        ),
      ),
    );
    _open = false;
    _openRequired = false;
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// "Update available" on Home, with the store a tap away.
class AppUpdateCard extends ConsumerWidget {
  const AppUpdateCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The pop-up is AppUpdateGate's, above every screen; this card stays on
    // Home for whoever pressed Later.
    final update = ref.watch(appUpdateProvider).valueOrNull;
    if (update == null) return const SizedBox.shrink();
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.lg),
      child: Material(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(NeoSpace.md),
          child: Row(
            children: [
              Icon(Icons.system_update_rounded, color: p.primary),
              const SizedBox(width: NeoSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Update available', style: text.titleSmall),
                    Text(
                      'NeoLinguaMeet ${update.latest} is on the LoveWorld AppStore. You have ${update.current}.',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: NeoSpace.sm),
              FilledButton(
                onPressed: () => openAppUpdate(update.storeUrl),
                child: const Text('Update'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
