// src/app/robots.ts — served as /robots.txt.
//
// The public pages are for search engines; accounts, meetings in progress
// and the admin are not. On the old domain this is redirected like any page
// once the site is NeoLinguaMeet (src/lib/brand.ts).

import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin", "/dashboard", "/room/", "/video/room", "/sign-in", "/sign-up", "/app/"],
      },
    ],
    sitemap: `${BRAND.origin}/sitemap.xml`,
    host: BRAND.origin,
  };
}
