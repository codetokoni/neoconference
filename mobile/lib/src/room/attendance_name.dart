import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../design/brand.dart';

/// The "Full name for attendance", asked before every meeting the app joins
/// (src/lib/attendeeName.ts and src/lib/attendanceName.ts on the server).
///
/// Only the meeting's organisers see it, in their attendance list; the
/// meeting itself keeps showing the display name (a KingsChat username). It
/// starts with the name confirmed last time, can be changed, and is confirmed
/// (POST /api/me/full-name) before the meeting is asked for a token. The
/// server checks the same rules and turns a join back without one
/// (`attendance_name_required`).
const attendanceNameRequired = 'Enter your full name for attendance';

const _maxLength = 100;

/// Letters in any script (with accents), then letters, marks, spaces,
/// apostrophes, hyphens and full stops — the server's rule exactly.
final _allowed = RegExp(r"^\p{L}[\p{L}\p{M} .'’‘-]*$", unicode: true);
final _letter = RegExp(r'\p{L}', unicode: true);

/// Extra spaces tidied away, as the server stores it.
String cleanAttendanceName(String v) => v.replaceAll(RegExp(r'\s+'), ' ').trim();

/// Why a typed name cannot be used, or null when it can.
String? attendanceNameProblem(String v) {
  final name = cleanAttendanceName(v);
  if (name.length > _maxLength) return 'Keep it under $_maxLength characters.';
  if (name.isEmpty) return attendanceNameRequired;
  if (name.contains('@')) return 'Enter your name, not an email address.';
  if (!_allowed.hasMatch(name)) {
    return 'Use letters only, with spaces, apostrophes or hyphens between them.';
  }
  if (_letter.allMatches(name).length < 2) return attendanceNameRequired;
  return null;
}

/// The join step: one field and a Join button, before anything connects.
class AttendanceNameStep extends StatefulWidget {
  const AttendanceNameStep({
    super.key,
    required this.api,
    required this.title,
    required this.onConfirmed,
    this.error,
    this.slug,
  });

  final ApiClient api;
  final String title;

  /// The meeting's slug: for one that lists churches or groups
  /// (src/lib/attendanceGroups.ts), the step asks which is theirs too.
  final String? slug;

  /// Called once the server has accepted the name; joins the meeting.
  final Future<void> Function(String name) onConfirmed;

  /// A refusal from the server to show (a join turned back for want of a name).
  final String? error;

  @override
  State<AttendanceNameStep> createState() => _AttendanceNameStepState();
}

class _AttendanceNameStepState extends State<AttendanceNameStep> {
  final _field = TextEditingController();
  final _focus = FocusNode();
  bool _loaded = false;
  bool _busy = false;
  String? _problem;

  /// The meeting's churches or groups (none: not asked), and their pick.
  List<String> _groups = const [];
  String? _group;
  String? _groupProblem;

  @override
  void initState() {
    super.initState();
    _problem = widget.error;
    _loadSaved();
  }

  @override
  void didUpdateWidget(AttendanceNameStep old) {
    super.didUpdateWidget(old);
    if (widget.error != null && widget.error != old.error) {
      setState(() => _problem = widget.error);
      _focus.requestFocus();
    }
  }

  /// The name confirmed last time, or a suggestion; never a username or an
  /// email (the server decides). Typing is not held up if it fails.
  Future<void> _loadSaved() async {
    try {
      final slug = widget.slug;
      final body = await widget.api.get('/api/me/full-name', {'event': ?slug});
      final saved = body is Map ? body['fullName'] : null;
      if (mounted && saved is String && _field.text.isEmpty) _field.text = saved;
      final groups = body is Map && body['groups'] is List ? (body['groups'] as List).whereType<String>().toList() : const <String>[];
      final picked = body is Map ? body['group'] : null;
      if (mounted) {
        setState(() {
          _groups = groups;
          if (picked is String && groups.contains(picked)) _group = picked;
        });
      }
    } catch (_) {
      // Left blank to type in.
    } finally {
      if (mounted) setState(() => _loaded = true);
    }
  }

  Future<void> _submit() async {
    if (_busy || !_loaded) return;
    final local = attendanceNameProblem(_field.text);
    if (local != null) {
      setState(() => _problem = local);
      _focus.requestFocus();
      return;
    }
    if (_groups.isNotEmpty && _group == null) {
      setState(() => _groupProblem = 'Choose your church or group.');
      return;
    }
    final name = cleanAttendanceName(_field.text);
    _field.text = name;
    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      final body = await widget.api.post('/api/me/full-name', {
        'fullName': name,
        if (_groups.isNotEmpty) ...{'event': widget.slug, 'group': _group},
      });
      final saved = body is Map && body['fullName'] is String ? body['fullName'] as String : name;
      await widget.onConfirmed(saved);
    } on ApiException catch (e) {
      if (mounted) setState(() => _problem = e.message.isNotEmpty ? e.message : 'Your name could not be saved. Try again.');
      _focus.requestFocus();
    } catch (_) {
      if (mounted) {
        setState(() => _problem = 'Your name could not be saved. Check your connection and try again.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _field.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Stack(
      children: [
        Align(
          alignment: Alignment.topLeft,
          child: BackButton(onPressed: () => Navigator.of(context).maybePop()),
        ),
        Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 56),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Joining ${widget.title}',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: p.textMuted),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Confirm your name',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: p.text),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    "The meeting's organisers see this name in their attendance list. "
                    'Others in the meeting see your display name.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: p.textMuted),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    key: const Key('attendance-name'),
                    controller: _field,
                    focusNode: _focus,
                    enabled: _loaded && !_busy,
                    autofocus: true,
                    textCapitalization: TextCapitalization.words,
                    autofillHints: const [AutofillHints.name],
                    textInputAction: TextInputAction.go,
                    maxLength: _maxLength + 20,
                    onChanged: (_) {
                      if (_problem != null) setState(() => _problem = null);
                    },
                    onSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      labelText: 'Full name for attendance *',
                      hintText: _loaded ? 'Your first and last name' : 'Loading…',
                      errorText: _problem,
                      counterText: '',
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  if (_groups.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      key: const Key('attendance-group'),
                      initialValue: _group,
                      isExpanded: true,
                      items: [for (final g in _groups) DropdownMenuItem(value: g, child: Text(g, overflow: TextOverflow.ellipsis))],
                      onChanged: _busy ? null : (g) => setState(() {
                        _group = g;
                        _groupProblem = null;
                      }),
                      decoration: InputDecoration(
                        labelText: 'Your church or group *',
                        helperText: "Your group's leader gets their people's attendance after the meeting.",
                        helperMaxLines: 2,
                        errorText: _groupProblem,
                        border: const OutlineInputBorder(),
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    key: const Key('attendance-join'),
                    onPressed: _loaded && !_busy ? _submit : null,
                    child: Text(_busy ? 'Joining…' : 'Join'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
