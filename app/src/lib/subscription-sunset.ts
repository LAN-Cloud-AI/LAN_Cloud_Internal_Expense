/**
 * 一次性、不自动续费或已到期的订阅：只计入当前整期费用。
 * 一次性从订阅开始日展示 1 个月；其余在当前账期结束后的下一周期开始日失效。
 */

import {
  addMonthsClamped,
  lastCycleStartOnOrBefore,
  nextCycleStart,
  type BillingCycle,
} from './reimbursement-engine';

export type SunsetReason = 'one_time' | 'no_auto_renew' | 'term_ended';

export interface SunsetInput {
  billingCycle: BillingCycle | null;
  autoRenew: boolean;
  termStart: string | null;
  termEnd: string | null;
  billingAnchorDate: string | null;
}

export function sunsetReason(input: Pick<SunsetInput, 'billingCycle' | 'autoRenew' | 'termEnd'>): SunsetReason | null {
  if (!input.billingCycle) return null;
  if (input.billingCycle === 'one_time') return 'one_time';
  if (input.termEnd) return 'term_ended';
  if (!input.autoRenew) return 'no_auto_renew';
  return null;
}

export function lastBillableCycleStart(input: SunsetInput): string | null {
  const reason = sunsetReason(input);
  if (!reason || !input.billingCycle || !input.termStart) return null;
  if (input.billingCycle === 'one_time') return input.termStart;
  const anchor = input.billingAnchorDate || input.termStart;
  if (reason === 'no_auto_renew') return anchor;
  if (!input.termEnd) return null;
  return lastCycleStartOnOrBefore(anchor, input.billingCycle, input.termEnd);
}

/** 一次性从开始日展示一个月；周期订阅展示到当前账期的下一周期开始日。 */
export function displayUntil(input: SunsetInput): string | null {
  const reason = sunsetReason(input);
  if (!reason || !input.billingCycle || !input.termStart) return null;
  if (input.billingCycle === 'one_time') return addMonthsClamped(input.termStart, 1);
  const lastStart = lastBillableCycleStart(input);
  if (!lastStart) return null;
  return nextCycleStart(lastStart, input.billingCycle);
}

export function shouldMarkEnded(today: string, until: string): boolean {
  return today >= until;
}

/** 到期 / 一次性 / 不自动续费只生成当前整期；持续自动续费仍按条款截止日。 */
export function generationEndCap(input: {
  billingCycle: BillingCycle;
  autoRenew: boolean;
  termStart: string;
  termEnd: string | null;
}): string | undefined {
  const reason = sunsetReason(input);
  if (!reason) return input.termEnd ?? undefined;
  if (input.billingCycle === 'one_time') return input.termEnd ?? undefined;
  if (reason === 'term_ended') return input.termEnd ?? undefined;
  return input.termStart;
}
