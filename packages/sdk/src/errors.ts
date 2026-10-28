/** Thrown at construction for missing or unsafe configuration (failure-policy F15). */
export class NexwardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NexwardConfigError";
  }
}

/**
 * Thrown before any network call when an action is invalid (programmer error).
 * The callback is never executed.
 */
export class NexwardValidationError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "NexwardValidationError";
    this.issues = issues;
  }
}
