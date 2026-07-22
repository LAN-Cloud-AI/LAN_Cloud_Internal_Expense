import { describe, expect, it } from 'vitest';
import {
  extractCnyRate,
  rateToMinorUnitRational,
} from '../src/lib/fx';

describe('rateToMinorUnitRational', () => {
  it('把“1 USD = 7.1234 CNY”精确转换为“每美分多少人民币分”', () => {
    expect(rateToMinorUnitRational('7.1234', 2)).toEqual({
      numerator: 35617,
      denominator: 5000,
    });
  });

  it('支持日元等 0 位小数币种，且不使用浮点金额', () => {
    expect(rateToMinorUnitRational('0.051', 0)).toEqual({
      numerator: 51,
      denominator: 10,
    });
  });

  it.each(['', '0', '-1.2', 'NaN', '7.1e3'])('拒绝不安全或非正数的汇率 %s', (rate) => {
    expect(() => rateToMinorUnitRational(rate, 2)).toThrow();
  });
});

describe('extractCnyRate', () => {
  it.each([
    { payload: { rates: { CNY: '7.2' } }, expected: '7.2' },
    { payload: { data: { CNY: 7.2 } }, expected: 7.2 },
    { payload: { conversion_rates: { CNY: '7.2' } }, expected: '7.2' },
  ])('适配常见只读汇率返回体', ({ payload, expected }) => {
    expect(extractCnyRate(payload)).toBe(expected);
  });

  it('不接受缺少 CNY 字段的响应', () => {
    expect(() => extractCnyRate({ rates: { USD: '1' } })).toThrow();
  });
});
