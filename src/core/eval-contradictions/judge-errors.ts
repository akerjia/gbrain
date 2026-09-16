/**
 * eval-contradictions/judge-errors — first-class judge error collection.
 *
 * Codex caught a real bug: per-pair skip on judge throws (the C2 decision)
 * biases the headline number downward IF errors cluster around messy
 * contradiction-like pairs. The fix is to count errors in the denominator
 * and surface them with a typed reason in the output, not bury them in stderr.
 *
 * The `note` field on the counts block is for the human reader of the JSON.
 * It says explicitly that errors are counted, not hidden.
 */

import type { JudgeErrorKind, JudgeErrorRow, JudgeErrorsCounts } from './types.ts';

const ERROR_NOTE =
  'errors counted toward denominator; do not silently disappear from the report';

/**
 * Account/auth-shaped provider failures. These are deterministic — retrying
 * the next pair with the same key fails identically — and they used to fall
 * through to 'unknown', which is how a run whose every judge call returned
 * `insufficient credits` looked like an unexplained mystery instead of a
 * quota problem. Kept separate from 'http_5xx' (transient upstream) on purpose.
 *
 * Deliberately phrase/status specific; a bare number in model prose must not
 * match (same discipline as `src/core/ai/errors.ts`).
 */
const AUTH_OR_QUOTA_RE =
  // Quota / billing phrasings. `insufficient credits` is the live gateway
  // wording (HTTP 400) that motivated this bucket.
  /insufficient[\s_-]*(?:credit|quota|balance|funds)|quota[\s_-]*exceeded|exceeded your (?:current )?quota|credit balance is too low|(?:no|out of|ran out of|exhausted)[\s_-]*credits?|spend limit|billing_not_active|billing hard limit|payment required|http[\s/]*402\b|\b402\b[\s-]*(?:payment|insufficient)|status(?: code)?[\s:=]*402\b/;
const AUTH_OR_KEY_RE =
  /authentication_error|permission_error|(?:invalid|incorrect|bad|wrong)[\s_-]*(?:x-)?api[\s_-]*key|api[\s_-]*key[\s_-]*(?:is[\s_-]*)?(?:invalid|expired|missing|revoked|not[\s_-]*found)|unauthorized|(?:invalid|missing|bad|malformed)[\s'"]*authorization|authorization[\s'"]*(?:header|token)[\s'"]*(?:is[\s'"]*)?(?:invalid|missing|malformed)|invalid[\s'"]*(?:auth|bearer|access|refresh)[\s_-]*token|invalid[\s'"]*credential|http[\s/]*401\b|status(?: code)?[\s:=]*401\b|http[\s/]*403\b|status(?: code)?[\s:=]*403\b/;

/** Classify a thrown error into one of the typed kinds. Conservative; defaults to 'unknown'. */
export function classifyError(err: unknown): JudgeErrorKind {
  if (!err || typeof err !== 'object') return 'unknown';
  const msg = (err as Error).message?.toLowerCase?.() ?? '';
  if (msg.includes('parse') || msg.includes('json') || msg.includes('repair')) {
    return 'parse_fail';
  }
  if (msg.includes('refus') || msg.includes("can't help") || msg.includes('cannot help')) {
    return 'refusal';
  }
  // Checked before timeout/5xx: an exhausted key or revoked credential is not
  // a transient network condition and must not be lumped in with either.
  if (AUTH_OR_QUOTA_RE.test(msg) || AUTH_OR_KEY_RE.test(msg)) {
    return 'auth_or_quota';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return 'timeout';
  }
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('overload')
  ) {
    return 'http_5xx';
  }
  return 'unknown';
}

/** Mutable collector. Calling code pushes rows; finalize() returns the counts block. */
export class JudgeErrorCollector {
  private rows: JudgeErrorRow[] = [];

  record(pairId: string, err: unknown): void {
    const kind = classifyError(err);
    const reason = err instanceof Error ? err.message : String(err);
    this.rows.push({ kind, pair_id: pairId, reason });
  }

  rowsOut(): readonly JudgeErrorRow[] {
    return this.rows;
  }

  finalize(): JudgeErrorsCounts {
    const counts: JudgeErrorsCounts = {
      parse_fail: 0,
      refusal: 0,
      timeout: 0,
      http_5xx: 0,
      auth_or_quota: 0,
      unknown: 0,
      total: 0,
      note: ERROR_NOTE,
    };
    for (const row of this.rows) {
      counts[row.kind]++;
      counts.total++;
    }
    return counts;
  }
}
