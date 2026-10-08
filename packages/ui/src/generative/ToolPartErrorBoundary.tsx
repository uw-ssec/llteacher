/* --------------------------------------------------------------------------
   ToolPartErrorBoundary (#38) -- one broken renderer must not take down the
   transcript. The surface-level ErrorBoundary (#144) catches a crash, but
   by replacing the WHOLE conversation; this one wraps each tool part, so a
   figure that throws becomes a quiet "couldn't draw this" plate and every
   other message stays readable.
   -------------------------------------------------------------------------- */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  toolName: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ToolPartErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[generative-ui] ${this.props.toolName} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <figure className="gen-figure gen-figure--failed" role="note">
        <figcaption className="gen-figure__head">
          <span className="gen-figure__kicker">Figure unavailable</span>
        </figcaption>
        <p className="gen-figure__error">
          This figure couldn&apos;t be drawn. The rest of the conversation is unaffected; you can ask the tutor to try again.
        </p>
      </figure>
    );
  }
}
