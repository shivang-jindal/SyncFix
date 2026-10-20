/**
 * Number and money primitives shared by the API and the web client.
 *
 * SyncFix does not move money, but connected systems frequently do, so a
 * safe decimal/major-unit helper is available for transforms and previews.
 * RULE: amounts are integer minor units; binary floating point is never used
 * for a money calculation.
 */

/** ISO 4217 minor-unit exponent per currency code. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
});

const DEFAULT_EXPONENT = 2;

/** Currencies offered in the product UI. Anything valid ISO 4217 is accepted by the API. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze([
  'AED',
  'AUD',
  'BDT',
  'BGN',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'JPY',
  'KES',
  'KRW',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'RON',
  'RSD',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'VND',
  'ZAR',
]);

export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_CURRENCIES.includes(code.toUpperCase());
}

/** Minor-unit exponent for a currency. Unknown codes fall back to 2. */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/**
 * Convert a major-unit decimal *string or number* to integer minor units.
 * String maths keeps `10.005` deterministic instead of letting IEEE-754
 * mangle it. Rounds half away from zero.
 */
export function parseToMinor(input: string | number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const scale = 10 ** exponent;
  const text = typeof input === 'number' ? numberToDecimalString(input) : input.trim();

  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const paddedFraction = (fractionPart + '0'.repeat(exponent)).slice(0, exponent);
  const extraFraction = (fractionPart + '0'.repeat(exponent)).slice(exponent);
  const roundUp = extraFraction.length > 0 && Number(extraFraction[0]) >= 5;

  const base = Number(wholePart) * scale + Number(paddedFraction || '0');
  if (!Number.isSafeInteger(base)) return null;

  const minor = roundUp ? base + 1 : base;
  return negative ? -minor : minor;
}

/** Render integer minor units as a major-unit decimal string, e.g. `123456` USD -> `1234.56`. */
export function formatMinorAsDecimal(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Multiply an integer-minor amount by a decimal factor with half-away-from-zero rounding. */
export function multiplyMinor(minor: number, factor: string | number): number {
  const factorText = typeof factor === 'number' ? numberToDecimalString(factor) : factor.trim();
  if (factorText === '' || !/^-?\d+(\.\d+)?$/.test(factorText)) {
    throw new RangeError(`Invalid decimal factor: ${factorText}`);
  }
  const negative = factorText.startsWith('-');
  const unsigned = negative ? factorText.slice(1) : factorText;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scale = 10 ** fraction.length;
  const factorInt = Number(whole) * scale + Number(fraction || '0');

  const product = minor * factorInt;
  const negativeResult = product < 0;
  const magnitude = Math.abs(product);
  const quotient = Math.floor(magnitude / scale);
  const remainder = magnitude - quotient * scale;
  const rounded = remainder * 2 >= scale ? quotient + 1 : quotient;
  return negativeResult !== negative ? -rounded : rounded;
}

/** Sum a list of integer-minor amounts with overflow protection. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    assertMinorUnits(total);
  }
  return total;
}

export function assertMinorUnits(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Amount exceeds safe integer range: ${value}`);
  }
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
  const fixed = value.toFixed(12).replace(/0+$/, '');
  return fixed.endsWith('.') ? fixed.slice(0, -1) : fixed;
}