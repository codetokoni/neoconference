'use client';

// src/components/ConferenceErrorBoundary.tsx
//
// Keeps a render or DOM error in the meeting UI from blanking the page.
//
// Without a boundary, any error thrown while React commits the room UI
// reaches the root and Next replaces the whole page with "Application
// error: a client-side exception has occurred". That is what happened
// when a demoted participant's role toast hit a DOM node another
// component had moved (see MobileMoreMenu). This boundary sits inside
// <LiveKitRoom>, so the connection survives: it throws the broken UI away
// and mounts a fresh copy. If the UI keeps failing, it stops retrying and
// offers a reload instead of looping.
//
// Its children sit in one display:contents wrapper so tearing them down is
// a single removeChild of a node React placed itself. Without it, removing
// a subtree whose DOM has drifted throws again (removeChild of the node
// that was moved), and one desync counts as three failures.

import { Component, type ReactNode } from 'react';

/** More failures than this inside RETRY_WINDOW_MS stop the remounting. */
const MAX_RETRIES = 3;
const RETRY_WINDOW_MS = 30_000;

type State = { failed: boolean; gaveUp: boolean };

export default class ConferenceErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { failed: false, gaveUp: false };
  private failures: number[] = [];

  static getDerivedStateFromError(): Partial<State> {
    // Render nothing for this pass, which unmounts the broken UI;
    // componentDidCatch, which has the failure history, then decides
    // between a fresh copy and giving up.
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < RETRY_WINDOW_MS);
    this.failures.push(now);
    const gaveUp = this.failures.length > MAX_RETRIES;
    console.error(
      gaveUp
        ? '[conference] meeting UI keeps failing; showing reload'
        : '[conference] meeting UI failed; remounting it',
      error,
    );
    this.setState({ failed: false, gaveUp });
  }

  render() {
    if (this.state.gaveUp) {
      return (
        <div
          role="alert"
          data-conference-error="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: '#e2e8f0',
            fontSize: 14,
            textAlign: 'center',
            padding: 16,
          }}
        >
          <p style={{ margin: 0 }}>Something went wrong showing the meeting.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    if (this.state.failed) return null;
    return (
      <div style={{ display: 'contents' }}>
        {this.props.children}
      </div>
    );
  }
}
