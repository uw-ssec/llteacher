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

import { Component, createRef, type ErrorInfo, type ReactNode } from "react";

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
  // #298: the default fallback's own container -- focused the instant it
  // mounts (see componentDidUpdate below) so a render throw doesn't drop
  // focus to <body> the same way EditableTitle's exit paths used to. Only
  // meaningful for the default fallback below; a caller-supplied
  // `fallback` render prop owns its own markup and focus.
  private fallbackRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] caught a render error", error, info.componentStack);
  }

  componentDidMount() {
    // #298: covers a throw during the very FIRST render -- React applies
    // getDerivedStateFromError before that initial commit, so the fallback
    // is already showing by the time this fires and there is no "previous"
    // render for componentDidUpdate below to compare against.
    if (this.state.error && !this.props.fallback) {
      this.fallbackRef.current?.focus();
    }
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState) {
    // #298: focus the fallback exactly once, right as it appears on a
    // LATER render (a throw after the boundary already mounted clean) --
    // not on every re-render while it's already showing (which would steal
    // focus back from wherever the student moved to since).
    if (!prevState.error && this.state.error && !this.props.fallback) {
      this.fallbackRef.current?.focus();
    }
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
        <div className="error-boundary-fallback" role="alert" tabIndex={-1} ref={this.fallbackRef}>
          {/* Deliberately does NOT promise the draft survives: `draft` is
              ConversationView-local state, and this fallback replaces that
              component, so anything typed and unsent is already gone. It also
              does not say "reload" -- the button below calls reset(), which
              re-renders the same children and, per reset()'s own doc comment,
              will simply re-throw on a deterministic error. */}
          {/* h1, not h2: the only <h1> in this package lives inside
              ConversationView -- the component this fallback replaces -- and
              for the section chat it never renders at all. An h2 here would
              be the document's only heading, with no parent. */}
          <h1 className="error-boundary-fallback__label">Conversation stopped</h1>
          <p className="error-boundary-fallback__body">
            This conversation couldn&apos;t be displayed. Messages you already sent are saved;
            anything typed but not sent is gone. If trying again doesn&apos;t help, reload the
            page.
          </p>
          <button type="button" className="error-boundary-fallback__retry" onClick={this.reset}>
            Try again
            <span aria-hidden="true">→</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
