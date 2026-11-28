// How a parent holds a child now, as against how the child first came to it
// (issue #256). Adoption is one way to acquire a child, and the record keeps
// `origin: 'adopt'` for the claim's provenance and for doctor. It is not a
// lasting property. A resume starts a new harness in a tab Bellwether opens,
// with the child id in that harness's own adapter, and from then on the parent
// holds the child as one it started: a new session in the pane, such as after
// a /clear, is the same child, retirement takes its proofs, and a restart may
// close its pane. A session that comes back under an adoption, by hand or
// through agent_adopt, is held by adoption again. A child that another parent
// adopts belongs to that parent on the same rule, as an adopted child there.
import type { ChildRecord } from './types.ts';

/**
 * Whether the parent holds this child by adoption now: the process in its pane
 * is one Bellwether did not start, so the session is the child's whole
 * identity and the pane is not the parent's to close or clean up after.
 */
export function heldByAdoption(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return child.origin === 'adopt' && !child.launchedAt;
}
