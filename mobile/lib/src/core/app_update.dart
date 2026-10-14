import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart' show apiProvider;

/// A newer NeoConference on the LoveWorld AppStore than this one, from
/// GET /api/app/latest (src/lib/appRelease.ts). A meeting link opens
/// whatever app is installed, so the app has to say when it is out of date;
/// before 1.2.5 nothing did, and people stayed on old versions.
@immutable
class AppUpdate {
  const AppUpdate({required this.current, required this.latest, required this.storeUrl});
  final String current;
  final String latest;
  final String storeUrl;
}

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
    if (body is! Map) return null;
    final latest = body['latestVersion'];
    final store = body['storeUrl'];
    if (latest is! String || store is! String) return null;
    if (compareAppVersions(info.version, latest) >= 0) return null;
    return AppUpdate(current: info.version, latest: latest, storeUrl: store);
  } catch (_) {
    return null;
  }
});

/// "Update available" on Home, with the store a tap away.
class AppUpdateCard extends ConsumerWidget {
  const AppUpdateCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
                      'NeoConference ${update.latest} is on the LoveWorld AppStore. You have ${update.current}.',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: NeoSpace.sm),
              FilledButton(
                onPressed: () => launchUrl(Uri.parse(update.storeUrl), mode: LaunchMode.externalApplication),
                child: const Text('Update'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
