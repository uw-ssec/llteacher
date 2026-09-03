import { useEffect, useState } from "react";
import type { SidebarSection } from "@llteacher/ui";
import type { StudentHomeworkListResponse } from "../../shared/types";

/** #214: a section's real database id + its pre-existing conversation id
 *  (if the student has already started it) -- SidebarSection drops both,
 *  since @llteacher/ui's Sidebar only ever needed `number`/`title`/
 *  `status`. Keyed by `order` (== SidebarSection.number), the same key the
 *  Sidebar/handleSectionSelect already navigate by. */
export interface SectionMeta {
  id: string;
  conversationId: string | null;
}

/** Fetches the current student's homework list and adapts it into the
    Sidebar's section shape. SidebarSection's status union ("submitted" |
    "current" | "pending") has no direct equivalent for "not_started" /
    "overdue" / "in_progress_overdue" -- those all map onto "pending" for
    now; a richer Sidebar status vocabulary is a @llteacher/ui change out of
    scope for this issue. */
export function useStudentHomework() {
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const [sectionMetaByOrder, setSectionMetaByOrder] = useState<Map<number, SectionMeta>>(new Map());
  const [hwTitle, setHwTitle] = useState("");
  // #4: the tutor-conversations rail (TutorConversationsList) needs a
  // courseId to scope GET/POST /api/conversations -- this hook's homework
  // fetch is the client's only source of course context today (see
  // StudentHomeworkSummary.courseId's doc comment), so it's threaded
  // through here rather than added as a second fetch.
  const [courseId, setCourseId] = useState<string | undefined>(undefined);
  // #304 (requirement 4): threaded from the same homework summary as
  // courseId above (StudentHomeworkSummary.courseName, the course's real
  // code) -- previously the TopNav/breadcrumb had "STATS 311" hardcoded as
  // a literal stand-in instead of deriving it from any server data at all.
  const [courseName, setCourseName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  // #160: distinct from "loaded, zero homeworks" -- a 401/403/503 must not
  // render as an indistinguishable empty sidebar. r.ok was never checked
  // before, so a non-2xx error-body response (`{ error: "..." }`) was cast
  // straight to StudentHomeworkListResponse; data.homeworks[0] then threw a
  // TypeError inside the .then chain that the trailing .catch swallowed.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    fetch("/api/student/homeworks")
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load student homeworks: ${r.status}`);
        return r.json() as Promise<StudentHomeworkListResponse>;
      })
      .then((data) => {
        const hw = data.homeworks[0]; // single-homework sidebar UI, matches current design
        if (!hw) {
          setLoading(false);
          return;
        }
        setHwTitle(hw.title);
        setCourseId(hw.courseId);
        setCourseName(hw.courseName);
        setSections(
          hw.sections.map((s) => ({
            number: s.order,
            title: s.title,
            status:
              s.status === "submitted"
                ? ("submitted" as const)
                : s.status === "in_progress"
                  ? ("current" as const)
                  : ("pending" as const),
            // #167: a section the overdue sweep submitted still maps to
            // "submitted" above -- the work really was submitted -- but the
            // row says so differently (SectionItem), because a student who
            // never pressed submit should not be left to conclude they did.
            autoSubmitted: s.submissionSource === "auto",
          })),
        );
        setSectionMetaByOrder(
          new Map(hw.sections.map((s) => [s.order, { id: s.id, conversationId: s.conversationId }])),
        );
        setLoading(false);
      })
      .catch(() => {
        setLoadError(true);
        setLoading(false);
      });
  }, []);

  // #271: setSectionMetaByOrder returned so the caller can update a
  // section's conversationId the moment the server mints one (chatFetch in
  // App.tsx) -- sectionMetaByOrder is the single source of truth for a
  // section's conversationId now that the redundant copy on SidebarSection
  // above is gone; previously this setter existed only inside this hook,
  // which made it structurally impossible for anything outside the hook to
  // keep the map current after the initial fetch.
  return { sections, setSections, sectionMetaByOrder, setSectionMetaByOrder, hwTitle, courseId, courseName, loading, loadError };
}
