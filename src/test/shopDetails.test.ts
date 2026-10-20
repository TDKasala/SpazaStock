import { describe, it, expect } from 'vitest';
import { emptyShopForm, normalizePhone, parseShopForm, provinceName } from '../lib/shopDetails';
import { locationFailure, parseCoordinates } from '../lib/geolocation';

const t = (key: string) => key;

describe('GPS coordinates', () => {
  it('rounds a reading and rejects anything outside the earth', () => {
    expect(parseCoordinates(-26.2041034, 28.0473056)).toEqual({ latitude: -26.204103, longitude: 28.047306 });
    expect(parseCoordinates(91, 0)).toBeNull();
    expect(parseCoordinates(0, 181)).toBeNull();
    expect(parseCoordinates(Number.NaN, 1)).toBeNull();
  });

  it('names a permission refusal, a timeout, and a missing GPS', () => {
    expect(locationFailure({ code: 1 })).toBe('denied');
    expect(locationFailure({ code: 3 })).toBe('timeout');
    expect(locationFailure(new Error('unsupported'))).toBe('unsupported');
    expect(locationFailure({ code: 2 })).toBe('unavailable');
  });
});

describe('normalizePhone', () => {
  it('turns South African numbers into international form', () => {
    expect(normalizePhone('082 123 4567')).toBe('+27821234567');
    expect(normalizePhone('(011) 555-0100')).toBe('+27115550100');
    expect(normalizePhone('27821234567')).toBe('+27821234567');
    expect(normalizePhone('+27 82 123 4567')).toBe('+27821234567');
  });

  it('keeps other countries when given with their code', () => {
    expect(normalizePhone('+251 91 123 4567')).toBe('+251911234567');
    expect(normalizePhone('00252 61 234 5678')).toBe('+252612345678');
  });

  it('treats blank as no number and refuses the rest', () => {
    expect(normalizePhone('  ')).toBeNull();
    expect(normalizePhone('082 123 456')).toBe('invalid');
    expect(normalizePhone('12345')).toBe('invalid');
    expect(normalizePhone('call me')).toBe('invalid');
  });
});

describe('parseShopForm', () => {
  it('needs only a name', () => {
    expect(parseShopForm({ ...emptyShopForm(), name: ' Spaza ' }, t)).toEqual({
      input: { name: 'Spaza', phone: null, address: null, city: null, province: null, latitude: null, longitude: null },
      errors: {},
    });
  });

  it('cleans the details', () => {
    const { input } = parseShopForm(
      { ...emptyShopForm(), name: 'Spaza', phone: '082 123 4567', address: ' 12  Main Road ', city: ' Soweto ', province: 'GP' },
      t
    );
    expect(input).toEqual({
      name: 'Spaza',
      phone: '+27821234567',
      address: '12 Main Road',
      city: 'Soweto',
      province: 'GP',
      latitude: null,
      longitude: null,
    });
  });

  it('reports each invalid field', () => {
    const { input, errors } = parseShopForm(
      { ...emptyShopForm(), name: '', phone: '123', address: 'x'.repeat(201), city: 'x'.repeat(101), province: 'XX' },
      t
    );
    expect(input).toBeUndefined();
    expect(errors).toEqual({
      name: 'onboarding.nameRequired',
      phone: 'onboarding.phoneInvalid',
      address: 'onboarding.addressTooLong',
      city: 'onboarding.cityTooLong',
      province: 'onboarding.provinceInvalid',
    });
  });

  it('keeps a GPS point with the shop', () => {
    const { input } = parseShopForm({ ...emptyShopForm(), name: 'Spaza', latitude: -26.204103, longitude: 28.047305 }, t);
    expect(input).toMatchObject({ latitude: -26.204103, longitude: 28.047305 });
  });

  it('names provinces by code', () => {
    expect(provinceName('KZN')).toBe('KwaZulu-Natal');
    expect(provinceName(null)).toBeNull();
  });
});
