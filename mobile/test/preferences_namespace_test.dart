import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/main_showcase.dart' show showcasePrefix;
import 'package:neoconference/src/design/themes.dart';
import 'package:neoconference/src/settings/meeting_defaults.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The showcase and production ship under one applicationId, so installing
/// one replaces the other and they inherit each other's stored preferences.
/// Reviewing themes in the showcase left `neo.theme` behind and the next
/// production build opened on Amethyst without anyone choosing it there.
///
/// These read and write through the real keys, not copies of them, so
/// renaming one in the app breaks the test rather than silently passing.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> asShowcase() async {
    SharedPreferences.resetStatic();
    SharedPreferences.setPrefix(showcasePrefix);
  }

  Future<void> asProduction() async {
    SharedPreferences.resetStatic();
    // The plugin's own default, which production has always used and which
    // is why production needs no migration.
    SharedPreferences.setPrefix('flutter.');
  }

  Future<void> write(String key, String value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, value);
  }

  Future<String?> read(String key) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(key);
  }

  setUp(() {
    SharedPreferences.resetStatic();
    // One in-memory store standing in for the one on the device, shared by
    // both entrypoints. resetStatic does not clear it, which is the point.
    SharedPreferences.setMockInitialValues({});
  });

  test('a theme chosen in the showcase does not reach production', () async {
    await asShowcase();
    await write(NeoThemeController.storageKey, 'amethyst');
    expect(await read(NeoThemeController.storageKey), 'amethyst');

    await asProduction();
    expect(
      await read(NeoThemeController.storageKey),
      isNull,
      reason: 'production saw the showcase\'s theme',
    );
  });

  test('a theme chosen in production does not reach the showcase', () async {
    await asProduction();
    await write(NeoThemeController.storageKey, 'ocean');

    await asShowcase();
    expect(
      await read(NeoThemeController.storageKey),
      isNull,
      reason: 'the showcase saw production\'s theme',
    );
  });

  test('each side keeps its own answer to the same key', () async {
    await asShowcase();
    await write(NeoThemeController.storageKey, 'amethyst');

    await asProduction();
    await write(NeoThemeController.storageKey, 'ocean');

    await asShowcase();
    expect(await read(NeoThemeController.storageKey), 'amethyst');

    await asProduction();
    expect(await read(NeoThemeController.storageKey), 'ocean');
  });

  test('the separation covers every key, not just the theme', () async {
    // The collision was found through the theme because that is the only
    // key both sides write today. Prefixing rather than renaming means the
    // next shared key is separated without anyone remembering to do it.
    await asShowcase();
    await write(MeetingDefaults.joinMutedKey, 'showcase');

    await asProduction();
    expect(await read(MeetingDefaults.joinMutedKey), isNull);
  });

  test('production reads what earlier production builds wrote', () async {
    // No migration: the fix namespaces the showcase, so a phone that has
    // only ever run the real app keeps its settings.
    SharedPreferences.resetStatic();
    SharedPreferences.setMockInitialValues({
      NeoThemeController.storageKey: 'carbon',
    });

    await asProduction();
    expect(await read(NeoThemeController.storageKey), 'carbon');
  });
}
