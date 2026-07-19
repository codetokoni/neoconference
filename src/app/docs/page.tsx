'use client';

import { useEffect } from 'react';

/**
 * Interactive API reference. Renders the OpenAPI spec at /openapi.json using
 * Scalar's standalone web component, loaded from CDN so no build-time
 * dependency is added to package.json.
 */
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
    <main style={{ minHeight: '100vh' }}>
      {/* Scalar reads configuration from this script tag's data attributes. */}
      <script
        id="api-reference"
        type="application/json"
        data-url="/openapi.json"
        dangerouslySetInnerHTML={{ __html: '{}' }}
      />
    </main>
  );
}
