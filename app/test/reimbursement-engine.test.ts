import { describe, expect, it } from 'vitest';
import {
  buildActualBillCandidates,
  buildAccrualCandidates,
  deriveContiguousPaidThrough,
  groupLockedCandidatesByPayer,
} from '../src/lib/reimbursement-engine';

describe('buildAccrualCandidates', () => {
  it('从上次已报销截至日的下一天起，按锚点账期生成可报销费用', () => {
    const candidates = buildAccrualCandidates({
      subscriptionId: 'sub-1',
      payerId: 'payer-a',
      currency: 'USD',
      amountMinor: 3_100,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-01-01',
      subscriptionStartDate: '2026-01-01',
      lastReimbursedThrough: '2026-01-31',
      cutoffDate: '2026-03-31',
      rate: { numerator: 700, denominator: 100 },
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        coverageStart: '2026-02-01',
        coverageEnd: '2026-02-28',
        originalAmountMinor: 3_100,
        cnyAmountFen: 21_700,
      }),
      expect.objectContaining({
        coverageStart: '2026-03-01',
        coverageEnd: '2026-03-31',
        originalAmountMinor: 3_100,
        cnyAmountFen: 21_700,
      }),
    ]);
  });

  it('终点不得超过订阅截止日或付款者有效期', () => {
    const candidates = buildAccrualCandidates({
      subscriptionId: 'sub-2',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 3_000,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-06-01',
      subscriptionStartDate: '2026-06-01',
      subscriptionEndDate: '2026-07-20',
      payerActiveUntil: '2026-07-15',
      cutoffDate: '2026-07-31',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toEqual(
      expect.objectContaining({
        coverageStart: '2026-07-01',
        coverageEnd: '2026-07-15',
        originalAmountMinor: 1_452,
        cnyAmountFen: 1_452,
      }),
    );
  });
});

describe('buildActualBillCandidates', () => {
  it('只为上次已报销日之后、截至日前已到期的完整账单生成候选', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-bill',
      payerId: 'payer-a',
      currency: 'USD',
      amountMinor: 1_500,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-01-01',
      subscriptionStartDate: '2026-01-01',
      lastReimbursedThrough: '2026-01-31',
      cutoffDate: '2026-03-15',
      rate: { numerator: 700, denominator: 100 },
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        coverageStart: '2026-02-01',
        coverageEnd: '2026-02-28',
        originalAmountMinor: 1_500,
        cnyAmountFen: 10_500,
      }),
      expect.objectContaining({
        coverageStart: '2026-03-01',
        coverageEnd: '2026-03-31',
        originalAmountMinor: 1_500,
        cnyAmountFen: 10_500,
      }),
    ]);
  });
});

describe('groupLockedCandidatesByPayer', () => {
  it('同一付款者的不同币种、不同覆盖期合并为一张 CNY 报销批次', () => {
    const groups = groupLockedCandidatesByPayer([
      {
        id: 'cand-usd',
        payerId: 'payer-a',
        coverageStart: '2026-07-01',
        coverageEnd: '2026-07-31',
        originalCurrency: 'USD',
        originalAmountMinor: 1_000,
        cnyAmountFen: 7_000,
      },
      {
        id: 'cand-cny',
        payerId: 'payer-a',
        coverageStart: '2026-06-01',
        coverageEnd: '2026-06-30',
        originalCurrency: 'CNY',
        originalAmountMinor: 500,
        cnyAmountFen: 500,
      },
      {
        id: 'cand-b',
        payerId: 'payer-b',
        coverageStart: '2026-07-01',
        coverageEnd: '2026-07-31',
        originalCurrency: 'CNY',
        originalAmountMinor: 1_200,
        cnyAmountFen: 1_200,
      },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        payerId: 'payer-a',
        coverageStart: '2026-06-01',
        coverageEnd: '2026-07-31',
        totalCnyFen: 7_500,
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'cand-usd' }),
          expect.objectContaining({ id: 'cand-cny' }),
        ]),
      }),
      expect.objectContaining({
        payerId: 'payer-b',
        totalCnyFen: 1_200,
      }),
    ]);
  });
});

describe('deriveContiguousPaidThrough', () => {
  it('不允许未来已付款明细跨越中间缺口推进付款者水位', () => {
    const watermark = deriveContiguousPaidThrough({
      startDate: '2026-01-01',
      paidCoverages: [
        { start: '2026-01-01', end: '2026-01-31' },
        { start: '2026-03-01', end: '2026-03-31' },
      ],
    });

    expect(watermark).toBe('2026-01-31');
  });
});
