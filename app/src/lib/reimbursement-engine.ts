/**
 * 不可变报销候选的纯计算引擎。
 *
 * 金额始终是最小货币单位整数：CNY 为分、USD 为美分。rate 表示
 * `CNY 分 / 原币最小单位` 的有理数，避免浮点数进入财务计算。
 */

export const BILLING_CYCLES = ['monthly', 'quarterly', 'semi_annual', 'yearly', 'one_time'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export interface RationalRate {
  numerator: number;
  denominator: number;
}

export interface AccrualCandidateRequest {
  subscriptionId: string;
  payerId: string;
  currency: string;
  amountMinor: number;
  billingCycle: BillingCycle;
  billingAnchorDate: string;
  subscriptionStartDate: string;
  subscriptionEndDate?: string;
  payerActiveFrom?: string;
  payerActiveUntil?: string;
  lastReimbursedThrough?: string;
  cutoffDate: string;
  rate: RationalRate;
}

export interface AccrualCandidateDraft {
  idempotencyKey: string;
  subscriptionId: string;
  payerId: string;
  coverageStart: string;
  coverageEnd: string;
  originalCurrency: string;
  originalAmountMinor: number;
  rateNumerator: number;
  rateDenominator: number;
  cnyAmountFen: number;
}

export interface LockedCandidate {
  id: string;
  payerId: string;
  coverageStart: string;
  coverageEnd: string;
  originalCurrency: string;
  originalAmountMinor: number;
  cnyAmountFen: number;
}

export interface PayerBatchPreview {
  payerId: string;
  coverageStart: string;
  coverageEnd: string;
  totalCnyFen: number;
  candidates: LockedCandidate[];
}

export interface PaidCoverage {
  start: string;
  end: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): Date {
  if (!ISO_DATE.test(value)) throw new Error(`invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDate(date) !== value) {
    throw new Error(`invalid calendar date: ${value}`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compareDate(left: string, right: string): number {
  return left.localeCompare(right);
}

function maxDate(...values: Array<string | undefined>): string {
  const defined = values.filter((value): value is string => Boolean(value));
  if (defined.length === 0) throw new Error('expected at least one date');
  defined.forEach(parseDate);
  return defined.sort().at(-1)!;
}

function minDate(...values: Array<string | undefined>): string {
  const defined = values.filter((value): value is string => Boolean(value));
  if (defined.length === 0) throw new Error('expected at least one date');
  defined.forEach(parseDate);
  return defined.sort()[0]!;
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function daysInclusive(start: string, end: string): number {
  const startMs = parseDate(start).getTime();
  const endMs = parseDate(end).getTime();
  if (endMs < startMs) throw new Error(`invalid coverage range: ${start}..${end}`);
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

/** Adds calendar months while pinning 29/30/31 to the target month's last day. */
export function addMonthsClamped(value: string, months: number): string {
  const original = parseDate(value);
  const desiredDay = original.getUTCDate();
  const year = original.getUTCFullYear();
  const month = original.getUTCMonth() + months;
  const firstOfTarget = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0),
  ).getUTCDate();
  firstOfTarget.setUTCDate(Math.min(desiredDay, lastDay));
  return formatDate(firstOfTarget);
}

export function monthsPerCycle(cycle: Exclude<BillingCycle, 'one_time'>): number {
  switch (cycle) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'semi_annual':
      return 6;
    case 'yearly':
      return 12;
  }
}

export function nextCycleStart(cycleStart: string, cycle: Exclude<BillingCycle, 'one_time'>): string {
  return addMonthsClamped(cycleStart, monthsPerCycle(cycle));
}

function cycleBounds(anchor: string, cycle: Exclude<BillingCycle, 'one_time'>, index: number) {
  const cycleStart = addMonthsClamped(anchor, index * monthsPerCycle(cycle));
  const nextCycleStart = addMonthsClamped(anchor, (index + 1) * monthsPerCycle(cycle));
  return { cycleStart, cycleEnd: addDays(nextCycleStart, -1) };
}

/** 不晚于 horizon 的最后一个账期开始日；若首期尚未开始则返回首期开始日。 */
export function lastCycleStartOnOrBefore(
  anchor: string,
  cycle: Exclude<BillingCycle, 'one_time'>,
  horizon: string,
): string {
  parseDate(anchor);
  parseDate(horizon);
  let index = 0;
  let bounds = cycleBounds(anchor, cycle, index);
  if (compareDate(bounds.cycleStart, horizon) > 0) return bounds.cycleStart;
  while (true) {
    const next = cycleBounds(anchor, cycle, index + 1);
    if (compareDate(next.cycleStart, horizon) > 0) return bounds.cycleStart;
    index += 1;
    if (index > 2_400) throw new Error('billing anchor is unreasonably old');
    bounds = next;
  }
}

function calculateCnyFen(originalAmountMinor: number, rate: RationalRate): number {
  if (!Number.isSafeInteger(originalAmountMinor) || originalAmountMinor < 0) {
    throw new Error('amountMinor must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(rate.numerator) ||
    !Number.isSafeInteger(rate.denominator) ||
    rate.numerator <= 0 ||
    rate.denominator <= 0
  ) {
    throw new Error('rate must be a positive integer rational');
  }
  return Math.round((originalAmountMinor * rate.numerator) / rate.denominator);
}

/**
 * 计算按天摊销候选。候选一经持久化即复制本函数产出的金额、汇率与覆盖期间，
 * 不会因订阅主数据或日后汇率变化而重算历史。
 */
export function buildAccrualCandidates(
  request: AccrualCandidateRequest,
): AccrualCandidateDraft[] {
  const { billingCycle, billingAnchorDate, subscriptionStartDate, cutoffDate } = request;
  parseDate(billingAnchorDate);
  parseDate(subscriptionStartDate);
  parseDate(cutoffDate);

  const reimbursableStart = maxDate(
    subscriptionStartDate,
    request.payerActiveFrom,
    request.lastReimbursedThrough ? addDays(request.lastReimbursedThrough, 1) : undefined,
  );
  const reimbursableEnd = minDate(
    cutoffDate,
    request.subscriptionEndDate,
    request.payerActiveUntil,
  );
  if (compareDate(reimbursableStart, reimbursableEnd) > 0) return [];

  if (billingCycle === 'one_time') {
    if (
      compareDate(billingAnchorDate, reimbursableStart) < 0 ||
      compareDate(billingAnchorDate, reimbursableEnd) > 0
    ) {
      return [];
    }
    return [
      {
        idempotencyKey: `${request.subscriptionId}:${request.payerId}:${billingAnchorDate}:${billingAnchorDate}:one_time`,
        subscriptionId: request.subscriptionId,
        payerId: request.payerId,
        coverageStart: billingAnchorDate,
        coverageEnd: billingAnchorDate,
        originalCurrency: request.currency,
        originalAmountMinor: request.amountMinor,
        rateNumerator: request.rate.numerator,
        rateDenominator: request.rate.denominator,
        cnyAmountFen: calculateCnyFen(request.amountMinor, request.rate),
      },
    ];
  }

  let index = 0;
  let bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  while (compareDate(bounds.cycleEnd, reimbursableStart) < 0) {
    index += 1;
    if (index > 2_400) throw new Error('billing anchor is unreasonably old');
    bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  }

  const candidates: AccrualCandidateDraft[] = [];
  while (compareDate(bounds.cycleStart, reimbursableEnd) <= 0) {
    const coverageStart = maxDate(reimbursableStart, bounds.cycleStart);
    const coverageEnd = minDate(reimbursableEnd, bounds.cycleEnd);
    if (compareDate(coverageStart, coverageEnd) <= 0) {
      const originalAmountMinor = Math.round(
        (request.amountMinor * daysInclusive(coverageStart, coverageEnd)) /
          daysInclusive(bounds.cycleStart, bounds.cycleEnd),
      );
      candidates.push({
        idempotencyKey: `${request.subscriptionId}:${request.payerId}:${coverageStart}:${coverageEnd}:accrual`,
        subscriptionId: request.subscriptionId,
        payerId: request.payerId,
        coverageStart,
        coverageEnd,
        originalCurrency: request.currency,
        originalAmountMinor,
        rateNumerator: request.rate.numerator,
        rateDenominator: request.rate.denominator,
        cnyAmountFen: calculateCnyFen(originalAmountMinor, request.rate),
      });
    }
    index += 1;
    bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  }
  return candidates;
}

/**
 * 计算实际账单候选：只为截止日前已到达账期起点的应付账单建候选——账期一旦
 * 开始即代表真实付款已产生，整期金额全额可报；账期开始日晚于截止日（尚无
 * 真实付款）一律不生成。首期或续报首期不足整期时（订阅开始日晚于账期起点、
 * 或上次报销水位落在账期中段），该期未报部分按天折算，保证覆盖从订阅开始
 * 连续延伸到报销节点，不丢天数、不重复。这不是按天预测；实际扣款凭证录入后
 * 可覆盖此预估候选，但不会改写历史快照。
 */
export function buildActualBillCandidates(
  request: AccrualCandidateRequest,
): AccrualCandidateDraft[] {
  const { billingCycle, billingAnchorDate, subscriptionStartDate, cutoffDate } = request;
  parseDate(billingAnchorDate);
  parseDate(subscriptionStartDate);
  parseDate(cutoffDate);

  const reimbursableStart = maxDate(
    subscriptionStartDate,
    request.payerActiveFrom,
    request.lastReimbursedThrough ? addDays(request.lastReimbursedThrough, 1) : undefined,
  );
  const reimbursableEnd = minDate(
    cutoffDate,
    request.subscriptionEndDate,
    request.payerActiveUntil,
  );
  if (compareDate(reimbursableStart, reimbursableEnd) > 0) return [];

  if (billingCycle === 'one_time') {
    return buildAccrualCandidates(request);
  }

  let index = 0;
  let bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  while (compareDate(bounds.cycleEnd, reimbursableStart) < 0) {
    index += 1;
    if (index > 2_400) throw new Error('billing anchor is unreasonably old');
    bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  }

  const candidates: AccrualCandidateDraft[] = [];
  // 不足整期的首期/续报首期：该期账单已产生，按天折算未报剩余部分。
  if (compareDate(bounds.cycleStart, reimbursableStart) < 0) {
    const coverageEnd = minDate(bounds.cycleEnd, reimbursableEnd);
    const proratedAmountMinor = Math.round(
      (request.amountMinor * daysInclusive(reimbursableStart, coverageEnd)) /
        daysInclusive(bounds.cycleStart, bounds.cycleEnd),
    );
    candidates.push({
      idempotencyKey: `${request.subscriptionId}:${request.payerId}:${reimbursableStart}:${coverageEnd}:actual_bill`,
      subscriptionId: request.subscriptionId,
      payerId: request.payerId,
      coverageStart: reimbursableStart,
      coverageEnd,
      originalCurrency: request.currency,
      originalAmountMinor: proratedAmountMinor,
      rateNumerator: request.rate.numerator,
      rateDenominator: request.rate.denominator,
      cnyAmountFen: calculateCnyFen(proratedAmountMinor, request.rate),
    });
    index += 1;
    bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  }

  // 账期开始即代表真实付款：全额入账；账期开始日晚于截止日的周期不进入循环。
  while (compareDate(bounds.cycleStart, reimbursableEnd) <= 0) {
    candidates.push({
      idempotencyKey: `${request.subscriptionId}:${request.payerId}:${bounds.cycleStart}:${bounds.cycleEnd}:actual_bill`,
      subscriptionId: request.subscriptionId,
      payerId: request.payerId,
      coverageStart: bounds.cycleStart,
      coverageEnd: bounds.cycleEnd,
      originalCurrency: request.currency,
      originalAmountMinor: request.amountMinor,
      rateNumerator: request.rate.numerator,
      rateDenominator: request.rate.denominator,
      cnyAmountFen: calculateCnyFen(request.amountMinor, request.rate),
    });
    index += 1;
    bounds = cycleBounds(billingAnchorDate, billingCycle, index);
  }
  return candidates;
}

/** A single submission creates exactly one reimbursement batch per payer. */
export function groupLockedCandidatesByPayer(
  candidates: LockedCandidate[],
): PayerBatchPreview[] {
  const groups = new Map<string, PayerBatchPreview>();
  const candidateIds = new Set<string>();

  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new Error(`candidate repeated in request: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (!Number.isSafeInteger(candidate.cnyAmountFen) || candidate.cnyAmountFen < 0) {
      throw new Error(`invalid CNY amount for candidate: ${candidate.id}`);
    }
    parseDate(candidate.coverageStart);
    parseDate(candidate.coverageEnd);

    const existing = groups.get(candidate.payerId);
    if (existing) {
      existing.coverageStart = minDate(existing.coverageStart, candidate.coverageStart);
      existing.coverageEnd = maxDate(existing.coverageEnd, candidate.coverageEnd);
      existing.totalCnyFen += candidate.cnyAmountFen;
      existing.candidates.push(candidate);
      continue;
    }
    groups.set(candidate.payerId, {
      payerId: candidate.payerId,
      coverageStart: candidate.coverageStart,
      coverageEnd: candidate.coverageEnd,
      totalCnyFen: candidate.cnyAmountFen,
      candidates: [candidate],
    });
  }

  return [...groups.values()].sort((left, right) => left.payerId.localeCompare(right.payerId));
}

/**
 * 从已付款明细推导连续的“已报销截至日”。未来付款不能越过中间未付款缺口。
 */
export function deriveContiguousPaidThrough({
  startDate,
  paidCoverages,
}: {
  startDate: string;
  paidCoverages: PaidCoverage[];
}): string | null {
  parseDate(startDate);
  let watermark: string | null = null;
  for (const coverage of [...paidCoverages].sort((left, right) =>
    left.start.localeCompare(right.start),
  )) {
    parseDate(coverage.start);
    parseDate(coverage.end);
    if (compareDate(coverage.end, coverage.start) < 0) {
      throw new Error(`invalid paid coverage: ${coverage.start}..${coverage.end}`);
    }
    const expectedStart = watermark ? addDays(watermark, 1) : startDate;
    if (compareDate(coverage.start, expectedStart) > 0) break;
    if (compareDate(coverage.end, expectedStart) >= 0) {
      watermark = watermark
        ? maxDate(watermark, coverage.end)
        : maxDate(addDays(startDate, -1), coverage.end);
    }
  }
  return watermark;
}
