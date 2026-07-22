import { describe, expect, it } from 'vitest';
import {
  buildSubmissionPlan,
  fingerprintBatchRequest,
  normalizeCandidateIds,
} from '../src/lib/reimbursement-submission';

describe('normalizeCandidateIds', () => {
  it('去除输入顺序差异并拒绝重复候选', () => {
    expect(normalizeCandidateIds([' cand-b ', 'cand-a'])).toEqual(['cand-a', 'cand-b']);
    expect(() => normalizeCandidateIds(['cand-a', 'cand-a'])).toThrow(/repeated/);
    expect(() => normalizeCandidateIds([])).toThrow(/at least one/);
  });
});

describe('fingerprintBatchRequest', () => {
  it('相同选择集合但不同传参顺序产生同一幂等指纹', () => {
    expect(
      fingerprintBatchRequest({ cutoffDate: '2026-07-31', candidateIds: ['b', 'a'] }),
    ).toBe(fingerprintBatchRequest({ cutoffDate: '2026-07-31', candidateIds: ['a', 'b'] }));
  });

  it('不同截止日不能复用同一请求语义', () => {
    expect(
      fingerprintBatchRequest({ cutoffDate: '2026-07-31', candidateIds: ['a'] }),
    ).not.toBe(fingerprintBatchRequest({ cutoffDate: '2026-08-31', candidateIds: ['a'] }));
  });
});

describe('buildSubmissionPlan', () => {
  it('一次选择按付款者拆为多个单付款者批次，并以锁定 CNY 快照合计', () => {
    const plan = buildSubmissionPlan({
      cutoffDate: '2026-07-31',
      candidates: [
        {
          id: 'c-1',
          payerId: 'payer-a',
          coverageStart: '2026-07-01',
          coverageEnd: '2026-07-31',
          originalCurrency: 'USD',
          originalAmountMinor: 1000,
          rateNumerator: 700,
          rateDenominator: 100,
          cnyAmountFen: 7000,
        },
        {
          id: 'c-2',
          payerId: 'payer-b',
          coverageStart: '2026-07-01',
          coverageEnd: '2026-07-31',
          originalCurrency: 'CNY',
          originalAmountMinor: 500,
          rateNumerator: 1,
          rateDenominator: 1,
          cnyAmountFen: 500,
        },
        {
          id: 'c-3',
          payerId: 'payer-a',
          coverageStart: '2026-06-01',
          coverageEnd: '2026-06-30',
          originalCurrency: 'CNY',
          originalAmountMinor: 300,
          rateNumerator: 1,
          rateDenominator: 1,
          cnyAmountFen: 300,
        },
      ],
    });

    expect(plan.batches).toEqual([
      expect.objectContaining({
        payerId: 'payer-a',
        coverageStart: '2026-06-01',
        coverageEnd: '2026-07-31',
        totalCnyFen: 7300,
        candidateIds: ['c-1', 'c-3'],
      }),
      expect.objectContaining({
        payerId: 'payer-b',
        totalCnyFen: 500,
        candidateIds: ['c-2'],
      }),
    ]);
  });
});
