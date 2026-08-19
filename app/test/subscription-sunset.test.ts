import { describe, expect, it } from 'vitest';
import { lastCycleStartOnOrBefore, nextCycleStart } from '../src/lib/reimbursement-engine';
import {
  displayUntil,
  generationEndCap,
  lastBillableCycleStart,
  shouldMarkEnded,
  sunsetReason,
} from '../src/lib/subscription-sunset';

describe('sunsetReason', () => {
  it('recognizes one-time, expired, and non-renewing subscriptions', () => {
    expect(sunsetReason({ billingCycle: 'one_time', autoRenew: true, termEnd: null })).toBe('one_time');
    expect(sunsetReason({ billingCycle: 'monthly', autoRenew: true, termEnd: '2026-12-31' })).toBe('term_ended');
    expect(sunsetReason({ billingCycle: 'monthly', autoRenew: false, termEnd: null })).toBe('no_auto_renew');
    expect(sunsetReason({ billingCycle: 'monthly', autoRenew: true, termEnd: null })).toBeNull();
  });
});

describe('displayUntil', () => {
  it('shows one-time subscriptions for one month from the start date', () => {
    expect(displayUntil({
      billingCycle: 'one_time',
      autoRenew: false,
      termStart: '2026-08-21',
      termEnd: null,
      billingAnchorDate: '2026-08-21',
    })).toBe('2026-09-21');
    expect(shouldMarkEnded('2026-09-20', '2026-09-21')).toBe(false);
    expect(shouldMarkEnded('2026-09-21', '2026-09-21')).toBe(true);
  });

  it('ends a non-renewing monthly subscription at the next cycle start', () => {
    expect(displayUntil({
      billingCycle: 'monthly',
      autoRenew: false,
      termStart: '2026-08-21',
      termEnd: null,
      billingAnchorDate: '2026-08-21',
    })).toBe('2026-09-21');
  });
});

describe('lastBillableCycleStart', () => {
  it('uses the term start for one-time and non-renewing subscriptions', () => {
    expect(lastBillableCycleStart({
      billingCycle: 'one_time',
      autoRenew: false,
      termStart: '2026-02-03',
      termEnd: null,
      billingAnchorDate: '2026-02-03',
    })).toBe('2026-02-03');
    expect(lastBillableCycleStart({
      billingCycle: 'monthly',
      autoRenew: false,
      termStart: '2026-08-21',
      termEnd: null,
      billingAnchorDate: '2026-08-21',
    })).toBe('2026-08-21');
  });

  it('uses the last cycle that started on or before the term end', () => {
    expect(lastBillableCycleStart({
      billingCycle: 'monthly',
      autoRenew: true,
      termStart: '2026-01-01',
      termEnd: '2026-03-20',
      billingAnchorDate: '2026-01-01',
    })).toBe('2026-03-01');
  });
});

describe('generationEndCap', () => {
  it('only bills the first cycle of a non-renewing subscription', () => {
    expect(generationEndCap({
      billingCycle: 'monthly',
      autoRenew: false,
      termStart: '2026-08-21',
      termEnd: null,
    })).toBe('2026-08-21');
  });

  it('lets auto-renewing open-ended subscriptions keep generating', () => {
    expect(generationEndCap({
      billingCycle: 'yearly',
      autoRenew: true,
      termStart: '2026-08-21',
      termEnd: null,
    })).toBeUndefined();
  });
});

describe('cycle boundaries', () => {
  it('treats 2026-08-21 through 2026-09-20 as one monthly cycle', () => {
    expect(nextCycleStart('2026-08-21', 'monthly')).toBe('2026-09-21');
    expect(nextCycleStart('2026-08-21', 'quarterly')).toBe('2026-11-21');
    expect(nextCycleStart('2026-08-21', 'yearly')).toBe('2027-08-21');
  });

  it('walks monthly cycles to the latest start on or before the horizon', () => {
    expect(lastCycleStartOnOrBefore('2026-01-31', 'monthly', '2026-03-15')).toBe('2026-02-28');
    expect(lastCycleStartOnOrBefore('2026-01-01', 'yearly', '2026-08-19')).toBe('2026-01-01');
  });
});
