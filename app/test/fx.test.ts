import { describe, expect, it } from 'vitest';
import {
  extractCnyRate,
  fetchCnyRate,
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

describe('fetchCnyRate', () => {
  it('按日期抓取历史汇率：把端点末段替换为日期并保留币种参数', async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ amount: 1, base: 'USD', date: '2026-05-20', rates: { CNY: 7.2 } }), { status: 200 });
    };
    const quote = await fetchCnyRate({
      baseCurrency: 'USD',
      providerUrl: 'https://api.frankfurter.dev/v1/latest',
      date: '2026-05-20',
      fetcher,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/v1/2026-05-20');
    expect(seen[0]).toContain('base=USD');
    expect(seen[0]).toContain('symbols=CNY');
    expect(seen[0]).not.toContain('latest');
    expect(quote.cnyPerWholeUnit).toBe(7.2);
    expect(quote.providerReference).toBe('2026-05-20');
  });

  it('未给日期时保持原端点（latest）', async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ date: '2026-07-22', rates: { CNY: '7.1' } }), { status: 200 });
    };
    await fetchCnyRate({ baseCurrency: 'EUR', providerUrl: 'https://api.frankfurter.dev/v1/latest', fetcher });
    expect(seen[0]).toContain('/v1/latest');
  });

  it('拒绝非法日期格式', async () => {
    await expect(fetchCnyRate({
      baseCurrency: 'USD',
      providerUrl: 'https://api.frankfurter.dev/v1/latest',
      date: '2026年5月20日',
    })).rejects.toThrow();
  });
});
