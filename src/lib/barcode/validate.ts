/**
 * Rejects camera reads that cannot be a real retail barcode. A misread of a printed EAN almost
 * always breaks its check digit, so checking it removes nearly all wrong product matches.
 * Codes are only trimmed, never rewritten, so a scan always matches what was saved earlier.
 */

const DIGITS = /^\d+$/;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export const CODE_128_MIN_LENGTH = 4;
export const CODE_128_MAX_LENGTH = 48;

/** GS1 mod-10 check for EAN-8, UPC-A, EAN-13 and ITF-14 (the last digit is the check digit). */
export function hasValidGtinCheckDigit(code: string): boolean {
  if (code.length < 2 || !DIGITS.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/** Expands an 8-digit UPC-E (number system, 6 data digits, check) to its 12-digit UPC-A form. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string;
  if (last <= '2') body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  return `${ns}${body}${check}`;
}

/** Returns the code to use, or null when the read should be ignored. */
export function validateBarcode(rawValue: string, format: string): string | null {
  const code = rawValue.trim();
  if (!code) return null;

  switch (format) {
    case 'ean_13':
      return code.length === 13 && hasValidGtinCheckDigit(code) ? code : null;
    case 'ean_8':
      return code.length === 8 && hasValidGtinCheckDigit(code) ? code : null;
    case 'upc_a':
      // Some decoders report UPC-A in its 13-digit EAN form with a leading zero.
      return (code.length === 12 || (code.length === 13 && code[0] === '0')) && hasValidGtinCheckDigit(code)
        ? code
        : null;
    case 'upc_e': {
      const expanded = expandUpcE(code);
      return expanded && hasValidGtinCheckDigit(expanded) ? code : null;
    }
    case 'itf':
    case 'itf_14':
      // Shorter ITF has no check digit and misreads easily; only cases use ITF-14.
      return code.length === 14 && hasValidGtinCheckDigit(code) ? code : null;
    case 'code_128':
      return code.length >= CODE_128_MIN_LENGTH &&
        code.length <= CODE_128_MAX_LENGTH &&
        PRINTABLE_ASCII.test(code)
        ? code
        : null;
    default:
      return null;
  }
}
