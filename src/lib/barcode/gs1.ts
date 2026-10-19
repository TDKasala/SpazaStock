/**
 * GS1 element string parsing for keyboard-wedge scanners.
 *
 * Supports:
 * - Symbology prefixes: ]d2 (GS1 DataMatrix), ]C1 (GS1-128)
 * - FNC1/GS separator (ASCII 29) between variable-length AIs
 * - AI 01 (GTIN-14), AI 17 (expiry YYMMDD with DD=00 = last day of month), AI 10 (batch/lot, variable length)
 *
 * The parser is strict enough for production use but lenient on unknown AIs: they are captured in `raw`
 * and skipped otherwise. Non-GS1 inputs return `{ kind: 'plain', code }`.
 *
 * Plain EAN/UPC inputs keep working: pass them through unchanged.
 */

const GS = String.fromCharCode(29); // ASCII 29 group separator, used as FNC1 terminator

export type Gs1Parse =
  | {
      kind: 'gs1';
      /** As typed, without the symbology prefix; ASCII 29 kept. */
      elementString: string;
      /** GTIN-14 (14 digits) from AI 01, if present and valid. */
      gtin14: string | null;
      /** Expiry date normalised to YYYY-MM-DD from AI 17, including the DD=00 rule. */
      expiry: string | null;
      /** Lot/batch number (AI 10), trimmed; may be empty when scanner sent a bare FNC1. */
      lot: string | null;
      /**
       * Candidate retail barcodes to try for product lookup, in preference order.
       * - When GTIN-14 starts with 0, includes the EAN-13 form (drop the leading 0).
       * - Otherwise only the 14-digit GTIN.
       * Empty when no AI 01 present.
       */
      lookupBarcodes: string[];
      /** All parsed AIs for debugging and tests. */
      raw: Record<string, string[]>;
    }
  | { kind: 'plain'; code: string };

/** Returns true when a string has only digits. */
function allDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Compute the last day of a calendar month. */
function lastDayOfMonth(year: number, month1to12: number): number {
  // JS Date: day 0 of next month = last day of current month.
  return new Date(year, month1to12, 0).getDate();
}

/** Normalise AI 17 "YYMMDD" where DD=00 means the last day of that month. */
export function normaliseAi17(yyMMdd: string): string | null {
  if (!/^\d{6}$/.test(yyMMdd)) return null;
  const yy = Number(yyMMdd.slice(0, 2));
  const mm = Number(yyMMdd.slice(2, 4));
  const dd = Number(yyMMdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  // GS1: 00–79 = 2000–2079, 80–99 = 1980–1999. Use the forward-looking mapping.
  const year = yy <= 79 ? 2000 + yy : 1900 + yy;
  const day = dd === 0 ? lastDayOfMonth(year, mm) : dd;
  // Basic validity check (e.g. Feb 31 → invalid).
  const d = new Date(Date.UTC(year, mm - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== day) return null;
  const mmStr = String(mm).padStart(2, '0');
  const ddStr = String(day).padStart(2, '0');
  return `${year}-${mmStr}-${ddStr}`;
}

/** Strip known symbology prefixes (e.g. ]d2, ]C1). */
function stripSymbologyPrefix(s: string): string {
  if (s.startsWith(']d2') || s.startsWith(']D2') || s.startsWith(']c1') || s.startsWith(']C1')) {
    return s.slice(3).trimStart();
  }
  return s;
}

/**
 * Parse a GS1 element string typed by a scanner in keyboard/HID mode.
 *
 * Example inputs:
 *  - "]d2 01046012345678931724060010BATCH123" (FNC1 as implicit between 17 and 10)
 *  - "0104601234567893\u001D10LOT-42\u001D17240600"
 */
export function parseGs1(input: string): Gs1Parse {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'plain', code: '' };
  const s = stripSymbologyPrefix(trimmed);
  // Fast check: GS1 strings start with an AI (2–4 digits). Plain barcodes often all-digit and
  // longer, but we only flip to GS1 mode when we recognise AI 01, 10 or 17 on decode.
  // We will still return 'plain' if we do not find a valid AI 01/10/17 pattern below.

  // Tokenise into AIs + data, honouring GS as a terminator for variable-length AIs.
  let i = 0;
  const values: Record<string, string[]> = {};
  function take(n: number): string {
    const out = s.slice(i, i + n);
    i += n;
    return out;
  }
  function push(ai: string, value: string) {
    (values[ai] ||= []).push(value);
  }

  // Helper to read a fixed-length numeric value.
  function readFixedDigits(len: number): string | null {
    const part = s.slice(i, i + len);
    if (part.length !== len || !allDigits(part)) return null;
    i += len;
    return part;
  }
  // Helper to read a variable-length value up to a GS or string end (maxLen enforced by GS1).
  function readVariable(maxLen: number): string {
    const end = s.indexOf(GS, i);
    const limit = end === -1 ? i + maxLen : Math.min(end, i + maxLen);
    const part = s.slice(i, limit);
    i = end === -1 ? limit : end + 1; // skip GS when present
    return part;
  }

  // Walk the element string. Unknown AIs are skipped as variable up to GS.
  while (i < s.length) {
    // Skip stray GS separators.
    if (s[i] === GS) {
      i++;
      continue;
    }
    const ai2 = s.slice(i, i + 2);
    if (!/^\d{2}$/.test(ai2)) break;
    i += 2;
    // The third and optionally fourth digit can be part of the AI.
    let ai = ai2;
    // Recognise 2, 3 or 4-digit AIs by patterns we actively use; fall back to 2-digit unknown.
    if (ai2 === '01') {
      const v = readFixedDigits(14);
      if (v) push('01', v);
      continue;
    }
    if (ai2 === '17') {
      const v = readFixedDigits(6);
      if (v) push('17', v);
      continue;
    }
    if (ai2 === '10') {
      const v = readVariable(20); // GS1 says up to 20 chars
      push('10', v);
      continue;
    }
    // Try 3- or 4-digit AIs for completeness; treat them as variable and store raw.
    const maybe3 = s.slice(i, i + 1);
    const maybe4 = s.slice(i, i + 2);
    if (/^\d$/.test(maybe3) && /^\d{4}$/.test(ai2 + maybe3)) {
      ai = ai2 + maybe3;
      i += 1;
    } else if (/^\d{2}$/.test(maybe4) && /^\d{4}$/.test(ai2 + maybe4)) {
      ai = ai2 + maybe4;
      i += 2;
    }
    // Unknown AI: variable up to GS, up to 30 chars by convention (spec varies per AI).
    const unknown = readVariable(30);
    push(ai, unknown);
  }

  const gtin14 = (values['01']?.[0] ?? null) && allDigits(values['01']![0]) && values['01']![0].length === 14 ? values['01']![0] : null;
  const expiry = values['17']?.[0] ? normaliseAi17(values['17']![0]) : null;
  const lot = values['10']?.[0] ?? null;

  if (!gtin14 && !expiry && lot === null) {
    // Not clearly GS1 for our AIs — treat as a plain barcode.
    return { kind: 'plain', code: trimmed };
  }

  const lookupBarcodes: string[] = [];
  if (gtin14) {
    lookupBarcodes.push(gtin14);
    if (gtin14.startsWith('0')) lookupBarcodes.push(gtin14.slice(1)); // EAN-13 form
  }

  return {
    kind: 'gs1',
    elementString: s,
    gtin14,
    expiry,
    lot,
    lookupBarcodes,
    raw: values,
  };
}

/** Makes invisible control characters visible for debugging (e.g. in "Test your scanner"). */
export function visualiseControlChars(s: string): string {
  return s.replaceAll(GS, '<GS>');
}

