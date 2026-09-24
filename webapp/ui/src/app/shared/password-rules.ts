/**
 * The password rule, mirrored from the server.
 *
 * The definition lives in `webapp/backend/domain/auth/services/password_rules.py`
 * and this is a copy for instant feedback while typing. The server is the one
 * that decides: it also runs the blocklist, which is not worth shipping to a
 * browser.
 *
 * What used to be here demanded a lowercase letter, an uppercase letter, a
 * digit, a symbol and eight characters, all at once, and showed only
 * "Still needed: ..." until every one was satisfied. NIST SP 800-63B says the
 * opposite in as many words: "Verifiers SHOULD NOT impose other composition
 * rules (e.g., requiring mixtures of different character types) for memorized
 * secrets." Composition rules push people towards `Password1!`, which meets all
 * of them and is on every breach list.
 *
 * `webapp/backend/tests/test_password_rules_match.py` reads this file and fails
 * if the numbers or the sentence drift from the Python.
 */

/** Shortest password accepted. Keep in step with MIN_LENGTH in the Python. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * bcrypt hashes the first 72 bytes and ignores the rest, so anything longer is
 * refused rather than silently truncated. Keep in step with MAX_BYTES.
 */
export const PASSWORD_MAX_BYTES = 72;

/** The sentence shown under the field before anything is typed. */
export const PASSWORD_RULES_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters, including a digit.`;

/** Bytes, not characters: what bcrypt counts. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The one thing wrong with this password, or null.
 *
 * One message at a time and in the order a person fixes them. Listing every
 * unmet rule at once is what made the old form feel like an argument.
 */
export function passwordProblem(value: string): string | null {
  if (!value) {
    return 'Choose a password.';
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (byteLength(value) > PASSWORD_MAX_BYTES) {
    return `That is too long. Keep it under ${PASSWORD_MAX_BYTES} characters.`;
  }
  if (!/\d/.test(value)) {
    return 'Add at least one digit.';
  }
  return null;
}
