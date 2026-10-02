import 'package:url_launcher/url_launcher.dart';

/// The website's help page, where the NeoSupport chat opens on arrival.
///
/// The widget is a web script (cdn.neosupport.org/neo-support.js) and the
/// app has no web view, so the app opens this page in an in-app browser
/// tab: the same chat, the same team, no second integration to keep up.
/// ?from=app keeps the website's Android "get the app" screen away for the
/// rest of that tab (/support itself is always open; links from it are not).
final supportPage = Uri.parse('https://www.neoconference.app/support?from=app');

/// Opens Help & support. Returns false when nothing could open it.
Future<bool> openSupport() => launchUrl(supportPage, mode: LaunchMode.inAppBrowserView);
