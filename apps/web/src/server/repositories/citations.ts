import type { Db } from "../../db/client";
import { citations } from "../../db/schema";

export interface ConceptCitation {
  conceptPath: string;
  conceptTitle: string;
  courseId: string;
  organizationId: string;
}

/** Builds the insert statement (unexecuted) so finalizeAssistantTurn can add
 *  it to the same batch or transaction as the assistant message. */
export function conceptCitationsInsert(target: Db, messageId: string, rows: ConceptCitation[]) {
  return target.insert(citations).values(
    rows.map((r) => ({
      messageId,
      gradeId: null,
      materialChunkId: null,
      conceptPath: r.conceptPath,
      conceptTitle: r.conceptTitle,
      courseId: r.courseId,
      organizationId: r.organizationId,
    })),
  );
}
