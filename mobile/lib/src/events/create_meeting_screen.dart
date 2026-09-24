import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../billing/upgrade.dart';
import '../core/api_client.dart';
import '../design/brand.dart';
import '../room/room_screen.dart';
import 'event.dart';
import 'languages.dart';

/// Creating a meeting from the phone.
///
/// Calls the same /api/events/create the website's form does, so the rules
/// about slugs, plan caps and translation live in one place. In particular
/// the language choice is plan-gated on the server: hiding the picker here
/// would be a courtesy, not a control, and the server refuses regardless.
class CreateMeetingScreen extends ConsumerStatefulWidget {
  const CreateMeetingScreen({super.key});

  @override
  ConsumerState<CreateMeetingScreen> createState() =>
      _CreateMeetingScreenState();
}

class _CreateMeetingScreenState extends ConsumerState<CreateMeetingScreen> {
  final _name = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  final _languages = <String>{};

  bool _waitingRoom = false;
  bool _waitForHost = true;
  String _visibility = 'unlisted';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final body = await ref.read(apiProvider).post('/api/events/create', {
        'name': _name.text.trim(),
        'visibility': _visibility,
        'waitingRoomEnabled': _waitingRoom,
        'waitForHost': _waitForHost,
        if (_languages.isNotEmpty) 'languages': _languages.toList(),
      });

      // The create route has returned the slug at the top level and nested
      // under `event` at different times; accept either rather than leave
      // someone staring at a meeting that was made but cannot be opened.
      String? slug;
      if (body is Map) {
        final top = body['slug'];
        if (top is String && top.isNotEmpty) {
          slug = top;
        } else {
          final nested = body['event'];
          if (nested is Map && nested['slug'] is String) {
            slug = nested['slug'] as String;
          }
        }
      }
      if (slug == null) {
        setState(() {
          _busy = false;
          _error = 'The meeting was created but no link came back.';
        });
        return;
      }

      final created = slug;
      ref.invalidate(eventsProvider);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => RoomScreen(slug: created, title: _name.text.trim()),
        ),
      );
    } on ApiException catch (e) {
      setState(() => _busy = false);
      // 402 with a named feature means the plan, not the request, is the
      // problem — so offer the way out rather than just reporting a wall.
      if (e.status == 402 && e.code == 'plan_upgrade_required') {
        if (!mounted) return;
        // Colour and shape come from bottomSheetTheme, so that a chosen
        // theme reaches the sheet as well as the screen behind it.
        showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => UpgradeSheet(
            reason: e.message,
            currentPlan: e.body['plan'] as String?,
          ),
        );
        return;
      }
      setState(() => _error = e.message);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = 'Could not create the meeting: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('New meeting')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Meeting name',
                hintText: 'Sunday Service',
              ),
              validator: (v) =>
                  (v ?? '').trim().isEmpty ? 'Give the meeting a name' : null,
            ),
            const SizedBox(height: 20),
            const _SectionLabel('Who can find it'),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'public', label: Text('Public')),
                ButtonSegment(value: 'unlisted', label: Text('Unlisted')),
                ButtonSegment(value: 'private', label: Text('Private')),
              ],
              selected: {_visibility},
              onSelectionChanged: (s) => setState(() => _visibility = s.first),
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _waitingRoom,
              onChanged: (v) => setState(() => _waitingRoom = v),
              title: Text('Waiting room', style: TextStyle(color: p.text)),
              subtitle: Text(
                'Every join has to be admitted by a host.',
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _waitForHost,
              onChanged: (v) => setState(() => _waitForHost = v),
              title: Text('Wait for a host', style: TextStyle(color: p.text)),
              subtitle: Text(
                'Nobody enters before a host arrives.',
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ),
            const SizedBox(height: 20),
            const _SectionLabel('Live translation'),
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                'Pick the languages this meeting will be translated into. '
                'Attendees choose from these in the room. Available on Pro '
                'and above.',
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final lang in meetingLanguages)
                  FilterChip(
                    label: Text('${lang.label} · ${lang.native}'),
                    selected: _languages.contains(lang.code),
                    onSelected: (on) => setState(() {
                      if (on) {
                        _languages.add(lang.code);
                      } else {
                        _languages.remove(lang.code);
                      }
                    }),
                    backgroundColor: p.surfaceAlt,
                    selectedColor: p.primary.withValues(alpha: 0.2),
                    checkmarkColor: p.primary,
                    labelStyle: TextStyle(color: p.text, fontSize: 12),
                    side: BorderSide(color: p.border),
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 20),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: p.danger.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: p.danger.withValues(alpha: 0.33)),
                ),
                child: Text(
                  _error!,
                  style: TextStyle(color: p.text, fontSize: 13),
                ),
              ),
            ],
            const SizedBox(height: 28),
            FilledButton(
              onPressed: _busy ? null : _create,
              child: _busy
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Create and join'),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
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
