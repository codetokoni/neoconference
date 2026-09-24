/// Where the app points, and the handful of constants that follow from it.
///
/// The mobile app has no backend of its own. It signs in against the same
/// Clerk instance as the website and then calls the very same API routes on
/// neoconference.app, so every rule about who may join a room, who may record
/// and who may mute whom stays in one place on the server.
class Config {
  const Config._();

  /// Overridable so a build can be pointed at a preview deployment:
  ///   flutter run --dart-define=NEO_SITE=https://neoconference-xyz.vercel.app
  static const site = String.fromEnvironment(
    'NEO_SITE',
    defaultValue: 'https://www.neoconference.app',
  );

  /// Clerk's Frontend API for this instance. Derived from the publishable
  /// key the website ships (pk_live_Y2xlcmsubmVvY29uZmVyZW5jZS5hcHAk, which
  /// is base64 for "clerk.neoconference.app$"), hard-coded here because it
  /// changes only if the whole Clerk instance is replaced.
  static const clerkFrontendApi = String.fromEnvironment(
    'NEO_CLERK_FAPI',
    defaultValue: 'https://clerk.neoconference.app',
  );

  /// Where the sign-in browser hands control back.
  ///
  /// An Android App Link, not a custom scheme: Android gives this URL to the
  /// app only after checking assetlinks.json on the domain and confirming
  /// this app is signed by the certificate named there. Any app can register
  /// a custom scheme, and the thing being handed back is a Clerk sign-in
  /// ticket, so a hijack would be an account takeover.
  ///
  /// Deliberately the canonical host rather than [site]: the App Link is
  /// verified against one domain, so pointing a preview build at a Vercel
  /// preview URL would silently stop the callback reaching the app.
  static const deepLinkCallback = 'https://www.neoconference.app/app/auth';
}
