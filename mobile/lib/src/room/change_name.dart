import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../events/event.dart' show apiProvider;

/// "Change my name" in the meeting's More menu: the name everyone in
/// meetings sees, as the web's (src/app/api/me/display-name). Saved on the
/// account for later meetings too, and everyone in this meeting sees it at
/// once. Empty goes back to the usual name (a KingsChat handle, for
/// instance). The name for attendance is separate.
const meetingNameMax = 60;

final _chars = RegExp(r"^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'’‘()&-]*$", unicode: true);
final _letters = RegExp(r'\p{L}', unicode: true);

/// Why a typed meeting name cannot be used, or null when it can (the
/// server's rules, src/lib/attendeeName.ts meetingNameProblem).
String? meetingNameProblem(String typed) {
  final name = typed.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (name.length > meetingNameMax) return 'Keep it under $meetingNameMax characters.';
  if (name.isEmpty) return 'Enter the name others should see.';
  if (name.contains('@')) return 'Enter a name, not an email address.';
  if (!_chars.hasMatch(name)) return 'Use letters and numbers, with spaces, full stops, apostrophes or hyphens.';
  if (_letters.allMatches(name).length < 2) return 'Enter at least two letters.';
  return null;
}

/// Saves the name; returns the name now shown, or throws [ApiException]
/// with the server's reason.
Future<String> saveMeetingName(ApiClient api, String typed, {String? room}) async {
  final body = await api.post('/api/me/display-name', {
    'name': typed.trim(),
    'room': ?room,
  });
  return body is Map && body['name'] is String ? body['name'] as String : typed.trim();
}

/// Opens the dialog; says so when the name was changed.
Future<void> openChangeName(BuildContext context, {required String current, String? room}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final saved = await showDialog<String>(
    context: context,
    builder: (_) => ChangeNameDialog(current: current, room: room),
  );
  if (saved != null) {
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('Everyone now sees you as $saved.')));
  }
}

class ChangeNameDialog extends ConsumerStatefulWidget {
  const ChangeNameDialog({super.key, required this.current, this.room});

  final String current;

  /// The LiveKit room this phone is in, so everyone there sees it at once.
  final String? room;

  @override
  ConsumerState<ChangeNameDialog> createState() => _ChangeNameDialogState();
}

class _ChangeNameDialogState extends ConsumerState<ChangeNameDialog> {
  late final _field = TextEditingController(text: widget.current);
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final typed = _field.text.trim();
    final problem = typed.isEmpty ? null : meetingNameProblem(typed);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final shown = await saveMeetingName(ref.read(apiProvider), typed, room: widget.room);
      if (mounted) Navigator.of(context).pop(shown);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.message.isNotEmpty ? e.message : 'Your name could not be changed. Try again.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'Your name could not be changed. Check your connection and try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Change my name'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('What everyone in the meeting sees, now and in later meetings. Leave it empty to go back to your usual name.'),
          const SizedBox(height: 12),
          TextField(
            key: const Key('change-name-field'),
            controller: _field,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            maxLength: meetingNameMax,
            decoration: InputDecoration(labelText: 'Name', errorText: _error, hintText: 'e.g. Pst Grace Okon'),
            onSubmitted: (_) => _busy ? null : _save(),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          key: const Key('change-name-save'),
          onPressed: _busy ? null : _save,
          child: Text(_busy ? 'Saving…' : 'Save'),
        ),
      ],
    );
  }
}
