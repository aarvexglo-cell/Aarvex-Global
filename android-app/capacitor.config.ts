import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Aarvex Global — Capacitor shell config.
 *
 * The app loads the LIVE CloudFront site (server.url) so every web deploy
 * reaches the app instantly, with no Play Store update. Native/plugin/permission
 * changes are the only thing that need a new AAB.
 *
 * `webDir: 'www'` is a small bundled fallback (loading/offline screen) used
 * before the remote site is reachable.
 */
const config: CapacitorConfig = {
  appId: 'com.aarvex.global',
  appName: 'Aarvex Global',
  webDir: 'www',

  server: {
    // ── OTA MIGRATION (Capgo live-updates) ──────────────────────────────────
    // OLD model: url pointed at the live CloudFront site, so EVERY launch loaded
    // the whole app over the network (slow, online-dependent).
    // NEW model: the app loads the LOCAL bundle in `www` (instant, offline) and
    // Capgo swaps in newer bundles it downloads in the background. For Capgo to
    // manage the bundle, `server.url` MUST stay disabled — a set url overrides
    // the bundle entirely. Re-enable it only to roll back to the old model.
    // url: 'https://dskm35im55r5u.cloudfront.net/portal.html',
    androidScheme: 'https',
    iosScheme: 'https',
    cleartext: false,
    // Keep navigation inside known hosts (auth, maps, API, tiles).
    allowNavigation: [
      'aarvexglobal.in',
      'www.aarvexglobal.in',
      'dskm35im55r5u.cloudfront.net',
      '*.amazonaws.com',
      '*.execute-api.ap-southeast-1.amazonaws.com',
      'apis.mappls.com',
      '*.mappls.com',
      'maps.googleapis.com',
      '*.googleapis.com',
      'accounts.google.com',
      '*.tile.openstreetmap.org',
      'challenges.cloudflare.com',
      '*.cloudflare.com',
    ],
  },

  android: {
    backgroundColor: '#0A0A0A',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },

  ios: {
    backgroundColor: '#0A0A0A',
    contentInset: 'always',
  },

  plugins: {
    // ── Capgo self-hosted OTA live-updates ──────────────────────────────────
    // App loads the local bundle instantly, then in the BACKGROUND asks our own
    // Lambda (updateUrl) whether a newer signed bundle exists; if so it downloads
    // it from our S3/CloudFront and applies it on the NEXT launch. autoResetWhenUpdate
    // + the notifyAppReady() call in ax-native.js give automatic ROLLBACK: if a
    // new bundle fails to become "ready" within appReadyTimeout, Capgo reverts to
    // the last known-good bundle — so a bad OTA can never brick the app.
    // SECURITY: paste YOUR base64 PUBLIC key below (generate the keypair with the
    // Capgo CLI; keep the PRIVATE key secret for the build/sign step). Only
    // bundles signed by your private key will ever be accepted on-device.
    CapacitorUpdater: {
      autoUpdate: true,
      updateUrl: 'https://j1yound90m.execute-api.ap-southeast-1.amazonaws.com/app-update',
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      appReadyTimeout: 10000,
      responseTimeout: 20,
      directUpdate: false,
      // SECURITY: v1 (now) = integrity via SHA-256 CHECKSUM (in the update JSON)
      // + HTTPS + bundles served ONLY from your own S3/CloudFront. That already
      // stops tampering/corruption. To ADD end-to-end signature authenticity
      // (v2), generate a Capgo keypair, sign bundles at build with the PRIVATE
      // key, and uncomment this with your base64 PUBLIC key — DON'T set a
      // placeholder here or Capgo will reject every (unsigned) bundle.
      // publicKey: 'YOUR_REAL_BASE64_PUBLIC_KEY',
    },
    // Perf (Tier 3): the splash used to hold for a full 3s on EVERY launch,
    // which — now that the shell paints instantly from the SW cache — was the
    // biggest source of "app feels slow to open". Cut to 0.8s so the cached
    // content shows almost immediately; auto-hide still guarantees it can never
    // get stuck if the remote site is slow.
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: '#0A0A0A',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    // M4: native Google Sign-In. serverClientId = the WEB OAuth client id whose
    // audience the backend verifies. The Android sign-in ALSO needs an "Android"
    // OAuth client (package com.aarvex.global + the build's SHA-1) in the SAME
    // Google Cloud project, else GoogleAuth.signIn() throws error 10.
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: '12128965047-cuoeqc9fasttr5v9aqoekso29m86o510.apps.googleusercontent.com',
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;
