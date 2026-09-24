import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../auth/auth_controller.dart';
import '../billing/plan.dart';
import '../billing/upgrade.dart';
import '../design/brand.dart';
import '../design/theme_picker.dart';
import '../home/landing_screen.dart';
import 'meeting_defaults.dart';

/// Settings for the production app.
///
/// Every row here does something. The two meeting switches are read by the
/// room when it connects, the theme really repaints the app, the plan is
/// the live one from the server, and signing out really ends the Clerk
/// session. A settings screen full of controls that change nothing is
/// worse than no settings screen, because it teaches people their
/// preferences are ignored.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _loaded = false;
  bool _joinMuted = true;
  bool _joinCameraOff = true;
  String _build = '';

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final muted = await MeetingDefaults.joinMuted();
    final cameraOff = await MeetingDefaults.joinCameraOff();
    String build = '';
    try {
      final info = await PackageInfo.fromPlatform();
      build = '${info.version} (${info.buildNumber})';
    } catch (_) {
      // Not knowing the build number is not a reason to withhold the screen.
    }
    if (!mounted) return;
    setState(() {
      _joinMuted = muted;
      _joinCameraOff = cameraOff;
      _build = build;
      _loaded = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final name = ref.watch(authProvider.select((s) => s.displayName));
    final plan = ref.watch(planProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        children: [
          _Account(name: name),
          const SizedBox(height: 28),

          const _Label('Your plan'),
          plan.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (e, _) => _Tile(
              title: 'Could not load your plan',
              subtitle: '$e',
              danger: true,
            ),
            data: (info) => _Tile(
              title: info.plan[0].toUpperCase() + info.plan.substring(1),
              subtitle: '${info.participantsLabel} · ${info.minutesLabel}',
              trailing: info.plan == 'enterprise'
                  ? null
                  : TextButton(
                      onPressed: () => _openUpgrade(context, info),
                      child: const Text('Upgrade'),
                    ),
            ),
          ),
          _Tile(
            title: 'Plans and pricing',
            subtitle: 'What each plan includes, in Espees',
            trailing: Icon(Icons.chevron_right_rounded, color: p.textFaint),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const LandingScreen()),
            ),
          ),
          const SizedBox(height: 28),

          const _Label('Meetings'),
          if (!_loaded)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: CircularProgressIndicator()),
            )
          else ...[
            _Tile(
              title: 'Join muted',
              subtitle: 'Your microphone starts off',
              trailing: Switch(
                value: _joinMuted,
                onChanged: (v) {
                  setState(() => _joinMuted = v);
                  MeetingDefaults.setJoinMuted(v);
                },
              ),
            ),
            _Tile(
              title: 'Join with camera off',
              subtitle: 'Arriving already on camera is a rude surprise',
              trailing: Switch(
                value: _joinCameraOff,
                onChanged: (v) {
                  setState(() => _joinCameraOff = v);
                  MeetingDefaults.setJoinCameraOff(v);
                },
              ),
            ),
          ],
          const SizedBox(height: 28),

          const _Label('Appearance'),
          const NeoThemePicker(),
          const SizedBox(height: 8),
          Text(
            'A meeting stays dark whichever theme you pick, unless the theme '
            'is already dark. Video reads better against black.',
            style: TextStyle(color: p.textFaint, fontSize: 11),
          ),
          const SizedBox(height: 28),

          const _Label('About'),
          _Tile(
            title: 'NeoConference',
            subtitle: _build.isEmpty ? 'neoconference.app' : _build,
          ),
          _Tile(
            title: 'Open neoconference.app',
            subtitle: 'Pricing, help and your account on the web',
            trailing: Icon(
              Icons.open_in_new_rounded,
              size: 18,
              color: p.textMuted,
            ),
            onTap: () => launchUrl(
              Uri.parse('https://www.neoconference.app/'),
              mode: LaunchMode.externalApplication,
            ),
          ),
          const SizedBox(height: 28),

          OutlinedButton.icon(
            onPressed: _confirmSignOut,
            icon: Icon(Icons.logout_rounded, color: p.danger),
            label: Text('Sign out', style: TextStyle(color: p.danger)),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
              side: BorderSide(color: p.danger.withValues(alpha: 0.5)),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmSignOut() async {
    final out = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
          'You will need to sign in with KingsChat again to join meetings.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: NeoTheme.of(context).danger,
              minimumSize: const Size(88, 44),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (out != true || !mounted) return;
    // Pop first: signing out swaps the root over to the sign-in screen, and
    // leaving Settings on top of that shows a signed-out person their plan.
    Navigator.of(context).pop();
    await ref.read(authProvider.notifier).signOut();
  }

  void _openUpgrade(BuildContext context, PlanInfo plan) {
    // Colour and shape come from bottomSheetTheme, so the sheet follows the
    // chosen theme along with the screen behind it.
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => UpgradeSheet(
        reason: plan.isFree
            ? 'You are on the Free plan.'
            : 'You are on the ${plan.plan} plan.',
        currentPlan: plan.plan,
      ),
    );
  }
}

class _Account extends StatelessWidget {
  const _Account({this.name});

  final String? name;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final label =
        (name != null && name!.trim().isNotEmpty) ? name!.trim() : 'Signed in';
    return Row(
      children: [
        Container(
          height: 52,
          width: 52,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              colors: [p.primary, p.info],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          alignment: Alignment.center,
          child: Text(
            label.substring(0, 1).toUpperCase(),
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: p.onPrimary,
            ),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Text(
            label,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: p.text,
            ),
          ),
        ),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          color: NeoTheme.of(context).primary,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.danger = false,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: danger ? p.danger.withValues(alpha: 0.33) : p.border,
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: danger ? p.danger : p.text,
                        ),
                      ),
                      if (subtitle != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            subtitle!,
                            style: TextStyle(
                              fontSize: 12,
                              color: p.textMuted,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (trailing != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: trailing,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
