export interface RationalRate {
  numerator: number;
  denominator: number;
}

export interface FetchedFxRate {
  baseCurrency: string;
  cnyPerWholeUnit: string | number;
  rawResponse: string;
  providerReference?: string;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function decimalToFraction(value: string | number): { numerator: bigint; denominator: bigint } {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error('FX rate must be a non-scientific decimal');
  }
  const [whole, fractional = ''] = raw.split('.');
  if (fractional.length > 12) throw new Error('FX rate has too many decimal places');
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(`${whole}${fractional}`);
  if (numerator <= 0n) throw new Error('FX rate must be positive');
  return { numerator, denominator };
}

/**
 * Converts a provider's “1 base currency whole unit = X CNY” quote into the
 * system's immutable `CNY fen / base currency minor unit` rational rate.
 */
export function rateToMinorUnitRational(
  cnyPerWholeUnit: string | number,
  sourceCurrencyMinorDigits: number,
): RationalRate {
  if (!Number.isInteger(sourceCurrencyMinorDigits) || sourceCurrencyMinorDigits < 0 || sourceCurrencyMinorDigits > 6) {
    throw new Error('source currency minor digits must be an integer from 0 to 6');
  }
  const quote = decimalToFraction(cnyPerWholeUnit);
  const rawNumerator = quote.numerator * 100n;
  const rawDenominator = quote.denominator * (10n ** BigInt(sourceCurrencyMinorDigits));
  const divisor = gcd(rawNumerator, rawDenominator);
  const numerator = rawNumerator / divisor;
  const denominator = rawDenominator / divisor;
  if (
    numerator > BigInt(Number.MAX_SAFE_INTEGER) ||
    denominator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('FX rate exceeds safe integer precision');
  }
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

/** Supports common read-only provider response envelopes without trusting a provider name. */
export function extractCnyRate(payload: unknown): string | number {
  if (!payload || typeof payload !== 'object') throw new Error('FX provider response is not an object');
  const record = payload as Record<string, unknown>;
  const containers = [record.rates, record.data, record.conversion_rates];
  for (const container of containers) {
    if (container && typeof container === 'object') {
      const value = (container as Record<string, unknown>).CNY;
      if (typeof value === 'string' || typeof value === 'number') return value;
    }
  }
  throw new Error('FX provider response does not include CNY');
}

/**
 * Fetches a quote through an explicit adapter contract. The configured endpoint
 * must accept `base=<currency>&symbols=CNY` and return one supported envelope.
 * `date`（YYYY-MM-DD）把端点最后一段替换为该日期以读取历史汇率（如 frankfurter
 * 的 /v1/2026-05-20）。This function never sends application secrets in URLs or returns them.
 */
export async function fetchCnyRate({
  baseCurrency,
  providerUrl,
  apiKey,
  date,
  fetcher = fetch,
}: {
  baseCurrency: string;
  providerUrl: string;
  apiKey?: string;
  date?: string;
  fetcher?: typeof fetch;
}): Promise<FetchedFxRate> {
  const url = new URL(providerUrl);
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('FX rate date must be YYYY-MM-DD');
    url.pathname = url.pathname.replace(/\/[^/]*$/, `/${date}`);
  }
  url.searchParams.set('base', baseCurrency);
  url.searchParams.set('symbols', 'CNY');
  const response = await fetcher(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`FX provider request failed with ${response.status}`);
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawResponse);
  } catch {
    throw new Error('FX provider response is not valid JSON');
  }
  return {
    baseCurrency,
    cnyPerWholeUnit: extractCnyRate(payload),
    rawResponse,
    providerReference:
      typeof (payload as Record<string, unknown>).date === 'string'
        ? ((payload as Record<string, unknown>).date as string)
        : undefined,
  };
}
