'use client';

import { useEffect } from 'react';

/**
 * Interactive API reference. Renders the OpenAPI spec at /openapi.json using
 * Scalar's standalone web component, loaded from CDN so no build-time
 * dependency is added to package.json. Themed to match the NeoConference
 * neon-cyan on near-black brand palette.
 */

const BRAND_CSS = `
  .scalar-app, .scalar-api-reference {
    --scalar-background-1: #03050a;
    --scalar-background-2: #070d18;
    --scalar-background-3: #0c1524;
    --scalar-background-accent: rgba(34, 211, 238, 0.12);
    --scalar-border-color: rgba(34, 211, 238, 0.16);
    --scalar-color-1: #e6f7ff;
    --scalar-color-2: #a9c7d6;
    --scalar-color-3: #6b8494;
    --scalar-color-accent: #22d3ee;
    --scalar-color-green: #34d399;
    --scalar-color-red: #fb7185;
    --scalar-color-blue: #22d3ee;
    --scalar-button-1: #22d3ee;
    --scalar-button-1-color: #03050a;
    --scalar-button-1-hover: #67e8f9;
    --scalar-sidebar-background-1: #05080f;
    --scalar-sidebar-color-1: #e6f7ff;
    --scalar-sidebar-color-2: #a9c7d6;
    --scalar-sidebar-border-color: rgba(34, 211, 238, 0.14);
    --scalar-sidebar-item-hover-background: rgba(34, 211, 238, 0.10);
    --scalar-sidebar-item-active-background: rgba(34, 211, 238, 0.16);
    --scalar-sidebar-color-active: #22d3ee;
    --scalar-sidebar-search-background: #070d18;
    --scalar-sidebar-search-border-color: rgba(34, 211, 238, 0.16);
  }
`;

export default function DocsPage() {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  return (
    <main style={{ minHeight: '100vh', background: '#03050a' }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_CSS }} />
      {/* Scalar reads configuration from this script tag's data attributes. */}
      <script
        id="api-reference"
        type="application/json"
        data-url="/openapi.json"
        data-configuration={JSON.stringify({
          theme: 'none',
          darkMode: true,
          hideDarkModeToggle: true,
          metaData: { title: 'NeoConference API Reference' },
        })}
        dangerouslySetInnerHTML={{ __html: '{}' }}
      />
    </main>
  );
}
