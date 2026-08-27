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
  /** #310: a retry was offered, taken, and the subtree threw again. The
   *  retry stops being offered at that point -- see `reset`. */
  retryFailed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, retryFailed: false };
  /* #310: whether the CURRENT error arrived after a retry. Held on the
     instance rather than in state because getDerivedStateFromError is
     static and cannot read either -- componentDidCatch, which runs just
     after it, promotes this into `retryFailed`. */
  private retried = false;
  // #298: the default fallback's own container -- focused the instant it
  // mounts (see componentDidUpdate below) so a render throw doesn't drop
  // focus to <body> the same way EditableTitle's exit paths used to. Only
  // meaningful for the default fallback below; a caller-supplied
  // `fallback` render prop owns its own markup and focus.
  private fallbackRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught a render error", error, info.componentStack);
    // #310: a throw arriving after a retry means the retry did not work,
    // and -- for the deterministic case this boundary exists for -- never
    // will. Stop offering it.
    if (this.retried) {
      this.retried = false;
      this.setState({ retryFailed: true });
    }
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

    /* #406: the retry button owns focus at the moment it is activated. If
       the render throws again, `retryFailed` becomes true and that button
       is REMOVED -- and the condition above does not fire, because both the
       previous and current error are non-null. The browser then drops focus
       to <body>.

       This boundary's #298 work exists precisely to stop a render error
       dropping focus to <body>, so the one-retry policy reintroduced the
       thing it was written to prevent -- on the path a keyboard user is
       most likely to take, since they had just pressed the button. */
    if (!prevState.retryFailed && this.state.retryFailed && !this.props.fallback) {
      this.fallbackRef.current?.focus();
    }

    /* #396: a retry that WORKED must not count against the next, unrelated
       error. `reset` sets `retried`, and componentDidCatch only cleared it
       when the retry failed -- so after any successful recovery the flag
       stayed true for the boundary's lifetime, and the next error was
       classified as a failed retry before the student had tried anything.
       Its fallback appeared with no retry button and copy saying trying
       again had not helped.

       That inverts the fix: #386 exists to stop offering a retry that
       cannot work, and this withheld one that would.

       The error-to-success edge is the signal. A retry that throws again
       never commits it -- React re-enters the error state instead -- so the
       failed-retry classification still works. */
    /* #396: a retry that WORKED must not count against the next, unrelated
       error. `reset` sets `retried`, and componentDidCatch only cleared it
       when the retry failed -- so after any successful recovery the flag
       stayed true for the boundary's lifetime and the next error was
       classified as a failed retry before the student had tried anything.

       #407: but this cannot clear SYNCHRONOUSLY here. If the retried
       subtree renders successfully and then throws in componentDidMount or
       a layout effect, this runs BEFORE React delivers that commit-phase
       error to componentDidCatch -- which would then see `retried === false`
       and never set retryFailed, so a deterministic commit-phase failure
       would keep offering a retry forever. The previous code had the
       opposite bug; getting the marker's lifetime right in both directions
       is the actual requirement.

       Deferring past the commit closes both: a commit-phase error is
       delivered before this microtask runs, so componentDidCatch still sees
       the marker, while an ordinary successful retry clears it a tick later
       with nothing depending on the gap. */
    if (prevState.error && !this.state.error) {
      queueMicrotask(() => {
        // Re-check: a commit-phase throw may have re-entered the error
        // state between scheduling and running, and that retry did fail.
        if (!this.state.error) {
          this.retried = false;
          if (this.state.retryFailed) this.setState({ retryFailed: false });
        }
      });
    }
  }

  /** Clears the caught error and lets `children` render fresh. This does
   *  NOT change whatever upstream state caused the throw -- if a parent
   *  doesn't also change props/key, a deterministic render error simply
   *  recurs.
   *
   *  #310: which is exactly what used to happen, silently and forever. The
   *  default fallback offered "Try again", the retry re-rendered the same
   *  failing subtree, it threw again, and the same button came back --
   *  including for the malformed-persisted-tool-part case this boundary
   *  exists for, where the bad data is loaded from the server on every
   *  render and cannot fix itself. A control that is certain to fail, and
   *  says nothing about it, is worse than no control.
   *
   *  The retry is now offered ONCE. If the subtree throws again after it,
   *  the default fallback drops the button and points at the one action
   *  that can still work. Callers supplying their own `fallback` are
   *  unaffected -- they receive `reset` exactly as before and decide their
   *  own policy. */
  reset = (): void => {
    this.retried = true;
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
            anything typed but not sent is gone.{" "}
            {this.state.retryFailed
              ? "Trying again didn't help, so reloading the page is the next step."
              : "If trying again doesn't help, reload the page."}
          </p>
          {/* #310: the retry is offered once. After it has been taken and
              the subtree threw again, the button is gone rather than
              sitting there certain to fail -- the sentence above says what
              to do instead. */}
          {!this.state.retryFailed && (
            <button type="button" className="error-boundary-fallback__retry" onClick={this.reset}>
              Try again
              <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
