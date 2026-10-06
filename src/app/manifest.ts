// src/app/manifest.ts — served as /manifest.webmanifest.
//
// What lets NeoConference be added to a phone's home screen as an app, and
// on iPhones what call alerts need: iOS only delivers Web Push to sites
// added to the Home Screen.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NeoConference",
    short_name: "NeoConference",
    description: "Video meetings with live translation.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#05070d",
    theme_color: "#05070d",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
