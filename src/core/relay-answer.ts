// A request sent over a relay connection whose answer never came back. It has
// a module of its own because both the relay links and the acts that ask over
// them, a restart and an adoption, need it, and neither should import the other.

/**
 * A request sent over a relay connection whose answer never came back: the
 * connection ended or the wait ran out after the request went out, so the far
 * side may have acted on it (issue #211).
 */
export class RelayAnswerLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayAnswerLost';
  }
}
