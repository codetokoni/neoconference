import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/load_error.dart';
import '../design/brand.dart';
import '../events/event.dart';

/// One device signed in to the account, as /api/auth/devices lists it.
@immutable
class SignedInDevice {
  const SignedInDevice({
    required this.id,
    required this.label,
    required this.current,
    this.ip,
    this.lastActiveAt,
  });

  factory SignedInDevice.fromJson(Map<String, dynamic> json) => SignedInDevice(
        id: json['id'] as String? ?? '',
        label: json['label'] as String? ?? 'Unknown device',
        current: json['current'] == true,
        ip: json['ip'] as String?,
        lastActiveAt: json['lastActiveAt'] is num
            ? DateTime.fromMillisecondsSinceEpoch((json['lastActiveAt'] as num).toInt())
            : null,
      );

  final String id;
  final String label;
  final bool current;
  final String? ip;
  final DateTime? lastActiveAt;
}

/// Settings → Security → Device sessions, the same as on the website: where
/// the account is signed in, signing out one device or all the others, and
/// "Allow login on multiple devices" (off: a sign-in on another device signs
/// this one out). The server keeps the rule (src/lib/deviceSessions.ts);
/// this only shows it and asks for changes.
class DeviceSessionsScreen extends ConsumerStatefulWidget {
  const DeviceSessionsScreen({super.key});

  @override
  ConsumerState<DeviceSessionsScreen> createState() => _DeviceSessionsScreenState();
}

class _DeviceSessionsScreenState extends ConsumerState<DeviceSessionsScreen> {
  bool? _multi;
  List<SignedInDevice>? _devices;
  Object? _loadError;
  String? _pending;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _take(dynamic body) {
    final map = body is Map<String, dynamic> ? body : const <String, dynamic>{};
    final list = map['devices'];
    setState(() {
      _multi = map['multiDevice'] == true;
      _devices = list is List
          ? list.whereType<Map<String, dynamic>>().map(SignedInDevice.fromJson).toList()
          : const [];
      _loadError = null;
    });
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final body = await ref.read(apiProvider).get('/api/auth/devices');
      if (mounted) _take(body);
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    }
  }

  Future<void> _act(String key, Map<String, dynamic> body) async {
    if (_pending != null) return;
    setState(() {
      _pending = key;
      _error = null;
    });
    try {
      final res = await ref.read(apiProvider).post('/api/auth/devices', body);
      if (mounted) _take(res);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : describeLoadError(e));
      _load();
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  static String _ago(DateTime at) {
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 1) return 'just now';
    if (d.inHours < 1) return '${d.inMinutes}m ago';
    if (d.inDays < 1) return '${d.inHours}h ago';
    return '${d.inDays}d ago';
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final devices = _devices;
    final others = devices?.where((d) => !d.current).toList() ?? const [];

    return Scaffold(
      appBar: AppBar(title: const Text('Device sessions')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            _Card(
              child: SwitchListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                title: Text(
                  'Allow login on multiple devices',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: p.text),
                ),
                subtitle: Text(
                  _multi == true
                      ? 'This account can stay signed in on several devices at once.'
                      : 'Off: signing in on another device signs this account out everywhere else.',
                  style: TextStyle(fontSize: 12, color: p.textMuted),
                ),
                value: _multi ?? false,
                onChanged: _multi == null || _pending != null
                    ? null
                    : (on) => _act('multi', {'action': 'multi', 'on': on}),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'SIGNED IN',
              style: TextStyle(color: p.primary, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8),
            ),
            const SizedBox(height: 10),
            if (devices == null && _loadError == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (devices == null)
              _Card(
                child: ListTile(
                  title: Text('Could not load your devices', style: TextStyle(color: p.text)),
                  subtitle: Text('${describeLoadError(_loadError!)} Tap to try again.',
                      style: TextStyle(color: p.textMuted, fontSize: 12)),
                  onTap: _load,
                ),
              )
            else
              for (final d in devices)
                _Card(
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                    title: Row(
                      children: [
                        Flexible(
                          child: Text(
                            d.label,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: p.text),
                          ),
                        ),
                        if (d.current) ...[
                          const SizedBox(width: 8),
                          Text('This device', style: TextStyle(fontSize: 11, color: p.primary, fontWeight: FontWeight.w600)),
                        ],
                      ],
                    ),
                    subtitle: Text(
                      [d.ip ?? 'IP unknown', if (d.lastActiveAt != null) 'active ${_ago(d.lastActiveAt!)}'].join(' · '),
                      style: TextStyle(fontSize: 12, color: p.textMuted),
                    ),
                    trailing: d.current
                        ? null
                        : TextButton(
                            onPressed: _pending != null ? null : () => _act(d.id, {'action': 'sign_out', 'id': d.id}),
                            child: Text(_pending == d.id ? 'Signing out…' : 'Sign out'),
                          ),
                  ),
                ),
            if (others.isNotEmpty) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: _pending != null ? null : () => _act('others', {'action': 'sign_out_others'}),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                child: Text(_pending == 'others' ? 'Signing out…' : 'Sign out all other devices'),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(color: p.danger, fontSize: 13)),
            ],
          ],
        ),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: p.surfaceAlt,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: p.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: child,
      ),
    );
  }
}
