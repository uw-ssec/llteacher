---
type: Bug
title: Hint suppression tests must wait for initial history
description: The hint button can render before initial section history arrives; suppression tests need a visible hydration precondition so history cannot replace their streamed reply.
tags: [frontend, tests, chat, ci]
generated: { by: "codex-desktop:gpt-6", at: "2026-10-08T21:41:12Z" }
status: stable
---

The rapid-double-click test in apps/web/src/client/App.test.tsx failed in CI because it clicked as soon as the hint button appeared. loadSectionConversation later replaced the section chat messages and identity with the initial history, erasing the reply. Holding history until after a visible reply and then releasing it reproduced the failure deterministically. The suppression test now waits for a visible history fixture before clicking and pins Date.now so runner load cannot move the clicks outside the suppression interval. Both the reply and single-request assertions remain. This test-only correction does not fix the underlying early-send/history overwrite behavior in App.tsx; that remains a separate product race. When testing sends on an existing conversation, wait for observable history hydration, not only a rendered input or button.

# Related Concepts
- [Chat surfaces rebuilt and re-scrolled on every streamed token](chat-rerender-per-token.md): Both depend on the lifecycle and rendering of the real streaming chat surface.
