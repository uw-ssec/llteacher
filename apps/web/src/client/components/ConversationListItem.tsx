import { memo } from "react";
import { ChatCircleText, Trash } from "@phosphor-icons/react";
import { EditableTitle } from "@llteacher/ui";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   ConversationListItem — one row in the tutor-conversations rail (#4).

   Renders a wire-shaped ConversationListItemResponse (shared/types.ts);
   lives in apps/web, not packages/ui, since packages/ui has no apps/web
   import anywhere.

   #295 redesign (post-review): the outer row is now a plain, non-
   interactive <div> -- NOT role="button". The previous version defended
   role="button" as necessary to contain EditableTitle's real nested pencil
   <button>, reasoning "a literal <button> can't contain a literal
   <button>." True, but ARIA 1.2 defines role="button" as Children
   Presentational: True and normatively prohibits interactive descendants
   too -- a real nested <button> inside a role="button" div is exactly the
   case that rule exists to prevent, and user agents prune that subtree
   (the pencil's role/name were not reliably exposed to assistive tech).
   The row's "select this conversation" affordance now lives on the title
   text itself, rendered as a real sibling <button> by EditableTitle (its
   `onActivateValue` prop, passed below) -- two adjacent buttons (title,
   pencil), no nesting, no ARIA violation. This div is now purely a
   layout/hover grouping for the row, not a target itself.
   -------------------------------------------------------------------------- */

export interface ConversationListItemProps {
  conversation: ConversationListItemResponse;
  isSelected: boolean;
  /** #290: this row's history fetch is in flight. Rendered as selected (so
   *  the click visibly registers immediately) plus `aria-busy`, which is
   *  what tells assistive tech the region is mid-update rather than done. */
  isPending?: boolean;
  onSelect: () => void;
  /** Persists a rename for this row's conversation. Rejects on failure --
   *  see EditableTitle's doc comment for how that's surfaced inline. */
  onRename: (newTitle: string) => Promise<void>;
  /** False hides the rename affordance entirely. Defaults to true: every
   *  conversation GET /api/conversations returns is already scoped to the
   *  caller's own rows (see routes/conversations.ts's listConversationsHandler
   *  doc comment), so every row in this list is the signed-in student's own
   *  conversation -- there is no non-owner case for this particular list
   *  today. The prop exists so a future non-owner-facing surface (e.g. a
   *  teacher viewing a student's conversation) can pass false without any
   *  change here. */
  isEditable?: boolean;
  /** #289: when provided, a delete affordance renders beside the rename
   *  pencil. The caller owns confirmation -- this only asks. Omitted
   *  renders nothing, so a non-owner surface stays read-only by default,
   *  matching `isEditable`'s reasoning. */
  onRequestDelete?: () => void;
  /** #310: true immediately after this row was moved to the front of the
   *  list by a real reorder (see useTutorConversations' bumpConversation).
   *  Renders a brief highlight so the shuffle is noticeable rather than
   *  just discovered after the fact. Defaults to false. */
  isRecentlyMoved?: boolean;
  /** #310: "now", for `formatUpdatedAt`'s today/not-today check. Optional,
   *  defaulting to `new Date()` at call time below purely so existing
   *  callers/tests that don't care about this distinction keep working
   *  unchanged. The list this row lives in (TutorConversationsList) always
   *  supplies it explicitly, computed ONCE per mount and reused across
   *  every row on every render -- this used to be a fresh `new Date()`
   *  constructed inside `formatUpdatedAt` on EVERY row on EVERY render
   *  (including one per streamed token, for every row, not just the active
   *  conversation's one being streamed to). Hoisting it up is also what
   *  makes `React.memo` below able to actually skip unaffected rows: a
   *  fresh Date object arriving as a prop every render would fail the
   *  shallow prop comparison for every row, every time, regardless of
   *  memoization. */
  now?: Date;
}

/** "3:45 PM" for today, "Jan 5" otherwise -- short enough for a 240px-ish
 *  rail without wrapping. #228: locale is `undefined` (not a hardcoded
 *  "en-US") so `Intl` resolves the viewer's own runtime default -- a
 *  hardcoded locale showed every student 12-hour "3:45 PM"/"Jan 5"
 *  formatting regardless of their own browser locale. The `options` object
 *  still controls the format (short month, numeric hour); only the locale
 *  argument changed. */
function formatUpdatedAt(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** #310: `React.memo`'d so this row skips re-rendering when neither its own
 *  props nor its own conversation object changed -- the list re-renders on
 *  every streamed token (App.tsx's chat state lives above the whole rail),
 *  and before this every row re-rendered with it regardless of whether
 *  that row's own data had moved at all. Only pays off because its props
 *  are now actually stable across those re-renders: `conversation` keeps
 *  its object identity for every row `bumpConversation`/rename don't touch
 *  (see useTutorConversations' own immutable-update comments), and
 *  `onSelect`/`onRename`/`onRequestDelete`/`now` are supplied by
 *  TutorConversationsList as per-id-cached, referentially stable callbacks
 *  and a single hoisted Date rather than fresh closures/Dates created
 *  inline on every render (see its own doc comments for how). */
export const ConversationListItem = memo(function ConversationListItem({
  conversation,
  isSelected,
  isPending = false,
  onSelect,
  onRename,
  isEditable = true,
  onRequestDelete,
  isRecentlyMoved = false,
  now = new Date(),
}: ConversationListItemProps) {
  const { id, title, updatedAt, messageCount } = conversation;
  // #233: the row keeps a short, stable accessible name ("Select
  // conversation: {title}") -- extending it to also read out the time and
  // count inline would still leave the name mismatched against every
  // caller that queries this row's own title text. aria-describedby
  // supplements the name with that metadata instead (most screen readers
  // announce name, then role, then description), which is the fix the
  // finding actually needs: the time and count reach assistive tech
  // without changing what the row is called.
  const metaId = `tutor-conversation-item__meta-${id}`;
  return (
    <li className="tutor-conversation-item-wrap">
      {/* #290: a pending row reads as selected. The click has to produce a
          visible change at once -- selection state used to derive entirely
          from the fetched result, so the whole in-flight window looked
          identical to a dead control, and the natural response (click
          again) just queued a duplicate fetch. */}
      <div
        className={
          [
            "tutor-conversation-item",
            isSelected || isPending ? "tutor-conversation-item--selected" : "",
            isPending ? "tutor-conversation-item--pending" : "",
            // #310: a brief highlight for a REAL reorder only -- see
            // useTutorConversations' recentlyMovedId doc comment. Combines
            // fine with --selected/--pending above; a row can be both the
            // active conversation and the one that just moved.
            isRecentlyMoved ? "tutor-conversation-item--reordered" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
        aria-busy={isPending || undefined}
      >
        {/* #403: title and its action controls share a horizontal row.
            .tutor-conversation-item is flex-direction: column, so a delete
            button placed as its direct child became its own row between the
            title and the metadata -- reserving that height on every
            conversation even while transparent. The rename pencil never had
            this problem because it lives inside EditableTitle; the delete
            control needs the same containment. */}
        <div className="tutor-conversation-item__row">
          <EditableTitle
            value={title}
            onSave={onRename}
            isEditable={isEditable}
            className="tutor-conversation-item__title"
            onActivateValue={onSelect}
            activateLabel={`Select conversation: ${title}`}
            activateDescribedBy={metaId}
            isActive={isSelected}
          />
          {/* #289: DELETE /api/conversations/:id shipped ownership-checked,
              404-on-not-owned and FK-safe, and no client code called it --
              from the student's side the rail was append-only. A real
              <button> sibling to the rename pencil, not nested in anything:
              the row is a plain div since #295's redesign precisely so
              adjacent controls stay individually exposed to assistive tech.
              The accessible name carries the title because "Delete" alone is
              indistinguishable between rows in a list. */}
          {onRequestDelete && (
            <button
              type="button"
              className="tutor-conversation-item__delete"
              onClick={onRequestDelete}
              aria-label={`Delete conversation: ${title}`}
            >
              <Trash size={13} weight="regular" aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="tutor-conversation-item__meta" id={metaId}>
          <span className="tutor-conversation-item__time">{formatUpdatedAt(updatedAt, now)}</span>
          {/* #233: visible text plus a visually-hidden expansion, not
              aria-label on a plain <span> -- aria-label support on a
              non-interactive element without a naming role isn't
              guaranteed the way it is on the title button above (#295:
              the accessible-name-bearing control here since the redesign
              that removed this row's own role="button"). */}
          <span className="tutor-conversation-item__count">
            {/* #292: a visible unit, not a bare numeral -- the word itself
                was sr-only, so a sighted student saw an unlabeled "6" with
                no way to tell it apart from, say, a time or an unread
                badge. The icon carries that meaning visually without
                spelling out "messages" at this size; the full word stays
                for assistive tech via the sr-only span below. */}
            <ChatCircleText className="tutor-conversation-item__count-icon" size={11} weight="regular" aria-hidden="true" />
            {messageCount}
            <span className="sr-only"> {messageCount === 1 ? "message" : "messages"}</span>
          </span>
        </span>
      </div>
    </li>
  );
});
