import { createSession, getSession, updateSession, deleteSession } from "../sessions.js";
import { storyStore } from "./runtime.js";

// Publish only a user-reviewed, fully prepared snapshot. The source story is
// untouched. A staging session is hidden from the sidebar until branch data is
// ready, and a failed publication is removed when possible.
export async function publishContinuityMigration({ title, sourceSessionId, prepared, continuityMode = "reviewed" }) {
  if (!["reviewed", "saver", "balanced"].includes(continuityMode)) throw new Error("Choose Reviewed, Balanced or Saver for the new story.");
  if (!prepared?.state || !Array.isArray(prepared.messages) ||
      prepared.state.branchId !== "main" || prepared.state.revision < 1)
    throw new Error("Preview and review the migration before creating the story copy.");
  const id = await createSession(title, { migrationStatus: "staging" });
  try {
    await storyStore(id).initialize({ state: prepared.state, messages: prepared.messages,
      initializationId: `init_${id}` });
    await updateSession(id, { continuityEnabled: true, continuityBranchId: "main",
      continuityMode, continuitySaverReviewEveryTurn: false,
      migrationStatus: "ready", migrationSourceSessionId: sourceSessionId });
    return id;
  } catch (error) {
    let current;
    try { current = await getSession(id); }
    catch { throw new Error(`Migration status is uncertain for staging story ${id}: ${error.message}`); }
    if (current?.continuityEnabled && current?.migrationStatus === "ready") return id;
    try { await deleteSession(id); }
    catch (cleanupError) {
      throw new Error(`Migration failed: ${error.message}. Staging story ${id} could not be removed: ${cleanupError.message}`);
    }
    throw error;
  }
}
