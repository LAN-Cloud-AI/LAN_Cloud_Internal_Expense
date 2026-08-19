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
  it('只为上次已报销日之后、账期已开始（真实付款已产生）的账单生成全额候选', () => {
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

  it.each([
    { cycle: 'monthly', expected: [['2026-05-20', '2026-06-19'], ['2026-06-20', '2026-07-19'], ['2026-07-20', '2026-08-19']] },
    { cycle: 'quarterly', expected: [['2026-05-20', '2026-08-19']] },
    { cycle: 'yearly', expected: [['2026-05-20', '2027-05-19']] },
  ] as const)('订阅开始日即锚点的 %s 订阅：账期开始即整期一次性入账，周期整期连续覆盖', ({ cycle, expected }) => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-cycles',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 1_200,
      billingCycle: cycle,
      billingAnchorDate: '2026-05-20',
      subscriptionStartDate: '2026-05-20',
      cutoffDate: '2026-07-22',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates.map((candidate) => [candidate.coverageStart, candidate.coverageEnd])).toEqual(expected);
    expect(candidates.every((candidate) => candidate.originalAmountMinor === 1_200)).toBe(true);
    expect(candidates.every((candidate) => candidate.coverageStart <= '2026-07-22')).toBe(true);
  });

  it('覆盖开始日晚于截止日的周期一律不生成（尚无真实付款）', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-future',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 1_200,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-08-01',
      subscriptionStartDate: '2026-08-01',
      cutoffDate: '2026-07-22',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates).toEqual([]);
  });

  it('月付从生效日整期一次性入账：2026-08-21 至 2026-09-20', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-month',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 19_900,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-08-21',
      subscriptionStartDate: '2026-08-21',
      cutoffDate: '2026-08-21',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        coverageStart: '2026-08-21',
        coverageEnd: '2026-09-20',
        originalAmountMinor: 19_900,
        cnyAmountFen: 19_900,
      }),
    ]);
  });

  it('一次性订阅只在开始日产生一条全额候选', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-once',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 59_600,
      billingCycle: 'one_time',
      billingAnchorDate: '2026-06-01',
      subscriptionStartDate: '2026-06-01',
      cutoffDate: '2026-07-22',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates).toEqual([
      expect.objectContaining({ coverageStart: '2026-06-01', coverageEnd: '2026-06-01', originalAmountMinor: 59_600, cnyAmountFen: 59_600 }),
    ]);
  });

  it('订阅开始日晚于账期锚点时，首期按天折算且不丢天数', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-partial',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 3_100,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-05-01',
      subscriptionStartDate: '2026-05-20',
      cutoffDate: '2026-06-30',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates.map((candidate) => [candidate.coverageStart, candidate.coverageEnd, candidate.originalAmountMinor])).toEqual([
      ['2026-05-20', '2026-05-31', 1_200],
      ['2026-06-01', '2026-06-30', 3_100],
    ]);
  });

  it('上次报销水位落在账期中段时，续报首期按天折算剩余部分', () => {
    const candidates = buildActualBillCandidates({
      subscriptionId: 'sub-resume',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 3_100,
      billingCycle: 'monthly',
      billingAnchorDate: '2026-01-01',
      subscriptionStartDate: '2026-01-01',
      lastReimbursedThrough: '2026-01-15',
      cutoffDate: '2026-02-28',
      rate: { numerator: 1, denominator: 1 },
    });

    expect(candidates.map((candidate) => [candidate.coverageStart, candidate.coverageEnd, candidate.originalAmountMinor])).toEqual([
      ['2026-01-16', '2026-01-31', 1_600],
      ['2026-02-01', '2026-02-28', 3_100],
    ]);
  });

  it('水位连续推进时同一期不会被重复报销', () => {
    const base = {
      subscriptionId: 'sub-chain',
      payerId: 'payer-a',
      currency: 'CNY',
      amountMinor: 3_100,
      billingCycle: 'monthly' as const,
      billingAnchorDate: '2026-05-01',
      subscriptionStartDate: '2026-05-20',
      rate: { numerator: 1, denominator: 1 },
    };
    const first = buildActualBillCandidates({ ...base, cutoffDate: '2026-06-30' });
    const second = buildActualBillCandidates({ ...base, lastReimbursedThrough: '2026-05-31', cutoffDate: '2026-06-30' });
    const third = buildActualBillCandidates({ ...base, lastReimbursedThrough: '2026-06-30', cutoffDate: '2026-07-22' });

    expect(first.map((c) => c.coverageEnd)).toEqual(['2026-05-31', '2026-06-30']);
    expect(second.map((c) => [c.coverageStart, c.coverageEnd])).toEqual([['2026-06-01', '2026-06-30']]);
    expect(third.map((c) => [c.coverageStart, c.coverageEnd, c.originalAmountMinor])).toEqual([['2026-07-01', '2026-07-31', 3_100]]);
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
