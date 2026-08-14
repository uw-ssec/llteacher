// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Message } from "./Message";

afterEach(cleanup);

// #300: aria-busy on the in-progress AI message suppresses per-chunk churn
// inside ConversationView's role="log" aria-live="polite" region (see that
// component's own #300 tests) -- a streamed reply announces once, whole,
// on completion instead of being re-announced on every appended token.
describe("Message aria-busy (#300)", () => {
  it("sets aria-busy=true on the ai message while isStreaming", () => {
    const { container } = render(
      <Message role="ai" isStreaming={true}>
        Partial answer…
      </Message>,
    );
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("true");
  });

  it("sets aria-busy=false once isStreaming is false", () => {
    const { container } = render(
      <Message role="ai" isStreaming={false}>
        Complete answer.
      </Message>,
    );
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("false");
  });

  it("defaults aria-busy=false when isStreaming is omitted", () => {
    const { container } = render(<Message role="ai">Complete answer.</Message>);
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("false");
  });
});
