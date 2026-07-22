import {
  groupLockedCandidatesByPayer,
  type LockedCandidate,
} from './reimbursement-engine';

export interface PersistedCandidateForSubmission extends LockedCandidate {
  rateNumerator: number;
  rateDenominator: number;
}

export interface SubmissionPlan {
  cutoffDate: string;
  candidateIds: string[];
  batches: Array<{
    payerId: string;
    coverageStart: string;
    coverageEnd: string;
    totalCnyFen: number;
    candidateIds: string[];
    candidates: PersistedCandidateForSubmission[];
  }>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, fieldName: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`${fieldName} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} is not a calendar date`);
  }
}

/**
 * The API treats a checkbox selection as a set. Duplicate IDs are an error:
 * accepting them would make a client-side retry look like a second expense.
 */
export function normalizeCandidateIds(candidateIds: unknown): string[] {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new Error('at least one candidate_id is required');
  }
  const normalized = candidateIds.map((candidateId) => {
    if (typeof candidateId !== 'string' || candidateId.trim().length === 0) {
      throw new Error('candidate_id must be a non-empty string');
    }
    return candidateId.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('candidate_id is repeated in request');
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

/**
 * Canonical, non-secret representation used as the input to the API's SHA-256
 * idempotency hash. It is deliberately deterministic, not a security hash by
 * itself.
 */
export function fingerprintBatchRequest({
  cutoffDate,
  candidateIds,
}: {
  cutoffDate: string;
  candidateIds: unknown;
}): string {
  assertIsoDate(cutoffDate, 'cutoff_date');
  return JSON.stringify({
    action: 'create_reimbursement_batches/v1',
    cutoff_date: cutoffDate,
    candidate_ids: normalizeCandidateIds(candidateIds),
  });
}

/**
 * Creates a pure, immutable write plan. The caller must obtain candidates from
 * D1 and never accept amount/payer/rate values supplied by the browser.
 */
export function buildSubmissionPlan({
  cutoffDate,
  candidates,
}: {
  cutoffDate: string;
  candidates: PersistedCandidateForSubmission[];
}): SubmissionPlan {
  assertIsoDate(cutoffDate, 'cutoff_date');
  const candidateIds = normalizeCandidateIds(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (candidate.coverageEnd > cutoffDate) {
      throw new Error(`candidate ${candidate.id} is after cutoff_date`);
    }
    if (
      !Number.isSafeInteger(candidate.rateNumerator) ||
      !Number.isSafeInteger(candidate.rateDenominator) ||
      candidate.rateNumerator <= 0 ||
      candidate.rateDenominator <= 0
    ) {
      throw new Error(`candidate ${candidate.id} has invalid locked FX rate`);
    }
  }

  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const batches = groupLockedCandidatesByPayer(candidates).map((group) => ({
    payerId: group.payerId,
    coverageStart: group.coverageStart,
    coverageEnd: group.coverageEnd,
    totalCnyFen: group.totalCnyFen,
    candidateIds: group.candidates.map((candidate) => candidate.id).sort(),
    candidates: group.candidates.map((candidate) => {
      const persisted = candidatesById.get(candidate.id);
      if (!persisted) throw new Error(`candidate ${candidate.id} is unavailable`);
      return persisted;
    }),
  }));

  return { cutoffDate, candidateIds, batches };
}
