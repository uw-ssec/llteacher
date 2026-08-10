/* --------------------------------------------------------------------------
   ErrorBoundary — catches render throws in its subtree.

   #144: no route-level `errorElement` and no component error boundary
   existed anywhere in either client app, so a render throw anywhere in the
   chat column (e.g. a malformed LLM tool-call shape reaching a generative
   component as the wrong type -- see packages/ui/src/generative/render.tsx's
   `parseShowDefinitionInput`) white-screened the *entire* app for the rest
   of the session, not just the conversation that triggered it.

   React only supports catching render errors via a class component's
   `static getDerivedStateFromError` / `componentDidCatch` -- there is no
   hook equivalent (see
   https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary),
   so this is deliberately a class despite the rest of this design system
   being function components.

   Scope: wrap the smallest subtree that can plausibly throw on bad
   server/model data (the chat column), not the whole app shell -- so a
   crash in one conversation's render doesn't also take out the sidebar/nav
   the student would otherwise use to navigate away from it.
   -------------------------------------------------------------------------- */

import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback renderer. Receives the caught error and a `reset`
   *  callback that clears the boundary's error state and re-renders
   *  `children` fresh. Defaults to a minimal inline message + retry
   *  button if omitted. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught a render error", error, info.componentStack);
  }

  /** Clears the caught error and lets `children` render fresh. Note this
   *  does NOT change whatever upstream state caused the throw -- if a
   *  parent doesn't also change props/key on retry (e.g. re-select the
   *  conversation), a deterministic render error will simply recur. That's
   *  fine for the malformed-tool-input case this exists for (a subsequent
   *  message won't carry the same bad shape), and callers that want a
   *  guaranteed-fresh remount can additionally key the boundary itself. */
  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div className="error-boundary-fallback" role="alert">
          <p>Something went wrong while rendering this conversation.</p>
          <button type="button" className="error-boundary-fallback__retry" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
