---
type: Bug
title: Chat surfaces rebuilt and re-scrolled on every streamed token
description: "useChat re-renders per chunk; unmemoized message building for both surfaces and a scroll effect keyed on array identity made work scale with token rate; fixed with memo, throttle, and length-keyed scroll."
tags: [frontend, performance, react, chat]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/client"]
sources:
  - resource: "issue #277"
  - resource: "issue #278"
  - resource: "PR #380"
  - resource: "issue #408"
  - resource: "issue #409"
---

## Root cause (#277, #278, fixed in PR #380)

The AI SDK's `useChat` re-renders `App` once per streamed chunk, a rate set by the model's token stream. Two expensive pieces of work were tied to that rate by accident:

1. **Both message lists rebuilt per chunk.** `buildMessageData` ran twice, unmemoized, on every render, including for the surface that was not on screen and whose inputs could not change.
2. **Scroll effect keyed on array identity.** The effect depended on the `messages` prop, a new array on every parent render, so it ran per token instead of per message. Each run forced synchronous layout of up to 200 hydrated nodes and restarted a smooth-scroll animation that never finished.

## Fix

- Memoize per surface and use the SDK's existing but unused `experimental_throttle`, which caps re-renders at one animation frame.
- Key the scroll effect on `messages.length`. Keep following a growing reply with a direct `scrollTop` write, which queues no animation.
- Honour `prefers-reduced-motion`. A JS-initiated smooth scroll is not covered by the design system's global CSS motion rule.

## Follow-ups still open (non-blocking)

- #409: keying on `messages.length` misses a same-length transcript replacement.
- #408: follow mode measures the viewport after content has grown, so a reader pinned to the bottom is read as having scrolled up.
- #400: tutor rail retry allows overlapping refetches with no request ordering.

## Lesson

With streaming hooks, audit which effects and derived computations run per chunk. Dependency arrays that take fresh arrays or objects from a parent run on every render.
