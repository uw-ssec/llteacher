# Design Principles — v2

Five principles that govern every visual and structural decision in LLTeacher v2.

---

## 1. Familiar bones, distinctive skin

Students already know how to use a chat interface. The conversational layout pattern — single-column scrolling messages, compose input at the bottom, navigation in a left rail — is not reinvented. It is adopted.

What changes is the skin: the warm off-white ground, the UW Husky Purple accent paired with Heritage Gold AI-voice markers, the Geist type system, the asymmetric student-message corner radius, the pure-text AI messages with no fill. Familiarity lowers the learning curve. Distinction creates identity.

**Anti-pattern:** redesigning the chat layout in service of visual originality. Students should spend zero cognitive budget figuring out how the interface works.

---

## 2. The sidebar is a syllabus, not a thread list

Every chat product shows recent conversations in the left rail. LLTeacher shows the sections of the current homework. This is the single structural decision that makes the product unmistakably educational.

The student's context is: "I am in Homework 3, currently working on Section 3 P-Values. I have submitted Section 1 and Section 2. Section 4 and Section 5 are ahead." That context is always visible. It replaces the useless "you had 47 conversations" thread history.

**Anti-pattern:** a sidebar that shows "Recent conversations" with timestamps. That is a chat product. This is a tutoring product.

---

## 3. Husky Purple is the chrome. Heritage Gold is the AI's voice. Paper is the content.

Three zones. Three color jobs. No overlap.

**UW Husky Purple `#32006e` — the chrome surface.** The top nav and sidebar are both Husky Purple. This is not "accent coverage" — per UW brand guidance, primary colors "should be used most often." Husky Purple is the primary. It dominates the frame of the product the way UW purple dominates Husky Stadium. An earlier version of this system mistakenly treated purple as a restrained accent (sub-15% rule). That rule applies to UW's _accent_ palette (teal, green, lavender). Husky Purple _is_ the primary.

Within the purple chrome, the gold family does work as structural punctuation: the HW label in Husky Gold print (`#B7A57A`), the Spirit Gold (`#FFC700`) current-section dot, the gold underline on hover. But this gold-on-purple relationship is a _chrome-internal_ contrast system — not the same semantic role as Heritage Gold on paper.

**UW Heritage Gold `#85754d` — the AI's voice.** On the paper surface only. The 4px speaker tick at the start of each AI turn. The pulsing streaming dot. Nothing else. Gold on paper marks "the AI is the source of this." This semantic is not diluted by the chrome-internal use of Husky Gold — the two golds are visually distinct in context (print-warm gold against warm white vs. warm gold against purple).

**Warm off-white `#FAFAF7` — the content ground.** The main conversation column stays paper. Every pixel of student-AI exchange happens here. Purple still appears on this surface for interactive signals (focus borders, composer focus ring) — but as an _interactive affordance_, not a surface.

The split is clear: purple frames the product; gold marks the AI; paper holds the conversation.

**Anti-pattern:** purple-to-blue gradients, vivid teal accents, multiple brand colors competing for attention without meaning. Each color must answer the question "what does this say?"

---

## 4. Typography is the interface

The choice of Geist Sans and Geist Mono is deliberate. Geist is a modern sans-serif designed for code-adjacent product UX — technically precise but not cold. Geist Mono pairs with it by design. The combination signals "serious tool built with care" without academic stuffiness.

Message rendering relies on typographic differentiation, not visual chrome:
- AI messages: no fill, no border, just text. A 4px Heritage Gold dot + mono "AI" label marks the speaker.
- Student messages: a soft surface (`#F2EFE9`) with an asymmetric radius (16/16/4/16). The bottom-right corner is the "pointing" corner.
- System messages: centered, muted, mono small-caps.

**Anti-pattern:** avatar images, colored speaker labels, emoji in messages, speech bubble tails, heavy borders distinguishing speakers. Typography handles differentiation. Visual chrome is redundant.

---

## 5. Motion is a budget, not a default

The entire motion budget:
- Streaming Heritage Gold dot pulse: 1.2s ease-in-out
- Compose input border transition on focus: 180ms ease-out
- Sidebar section hover underline: 120ms ease-out
- Submit arrow nudge on hover: 140ms ease-out
- Conversation column page-load entrance fade: 240ms

Nothing else moves. No per-message entrance animations. No scaling. No spring physics. No Motion library. Pure CSS only.

Motion attracts attention. Every animated element overrides static hierarchy. The streaming dot is the one element that should demand notice — it signals active AI generation. Everything else steps aside.

**Anti-pattern:** each message sliding up from below as it renders. Messages are not events. They are content. Render them as content.
