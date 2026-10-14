import { describe, it, expect } from 'vitest';
import { emptyShopForm, normalizePhone, parseShopForm, provinceName } from '../lib/shopDetails';

const t = (key: string) => key;

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
      input: { name: 'Spaza', phone: null, address: null, city: null, province: null },
      errors: {},
    });
  });

  it('cleans the details', () => {
    const { input } = parseShopForm(
      { name: 'Spaza', phone: '082 123 4567', address: ' 12  Main Road ', city: ' Soweto ', province: 'GP' },
      t
    );
    expect(input).toEqual({ name: 'Spaza', phone: '+27821234567', address: '12 Main Road', city: 'Soweto', province: 'GP' });
  });

  it('reports each invalid field', () => {
    const { input, errors } = parseShopForm(
      { name: '', phone: '123', address: 'x'.repeat(201), city: 'x'.repeat(101), province: 'XX' },
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

  it('names provinces by code', () => {
    expect(provinceName('KZN')).toBe('KwaZulu-Natal');
    expect(provinceName(null)).toBeNull();
  });
});
