/** South African provinces, stored by code. Names are proper nouns and are not translated. */
export const PROVINCES = [
  { code: 'EC', name: 'Eastern Cape' },
  { code: 'FS', name: 'Free State' },
  { code: 'GP', name: 'Gauteng' },
  { code: 'KZN', name: 'KwaZulu-Natal' },
  { code: 'LP', name: 'Limpopo' },
  { code: 'MP', name: 'Mpumalanga' },
  { code: 'NC', name: 'Northern Cape' },
  { code: 'NW', name: 'North West' },
  { code: 'WC', name: 'Western Cape' },
] as const;

export type ProvinceCode = (typeof PROVINCES)[number]['code'];

export const MAX_SHOP_NAME_LENGTH = 120;
export const MAX_ADDRESS_LENGTH = 200;
export const MAX_CITY_LENGTH = 100;

export function provinceName(code: string | null | undefined): string | null {
  return PROVINCES.find((p) => p.code === code)?.name ?? null;
}

/**
 * The phone number in international form, the same way the server stores it: a South African
 * number typed as 082 123 4567 becomes +27821234567. Blank is null.
 */
export function normalizePhone(text: string): string | null | 'invalid' {
  let phone = text.replace(/[\s().-]/g, '');
  if (!phone) return null;
  if (/^0\d{9}$/.test(phone)) phone = `+27${phone.slice(1)}`;
  else if (/^27\d{9}$/.test(phone)) phone = `+${phone}`;
  else if (/^00[1-9]\d{7,14}$/.test(phone)) phone = `+${phone.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : 'invalid';
}

/** Details for a new shop; everything but the name is optional. */
export interface NewShopInput {
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: ProvinceCode | null;
}

/** Form state, as typed. */
export interface ShopFormValues {
  name: string;
  phone: string;
  address: string;
  city: string;
  province: string;
}

export type ShopFormErrors = Partial<Record<keyof ShopFormValues, string>>;

export function emptyShopForm(): ShopFormValues {
  return { name: '', phone: '', address: '', city: '', province: '' };
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Validates the form; returns the cleaned input, or the errors to show next to each field. */
export function parseShopForm(
  values: ShopFormValues,
  t: (key: string) => string
): { input?: NewShopInput; errors: ShopFormErrors } {
  const errors: ShopFormErrors = {};
  const name = values.name.trim();
  const phone = normalizePhone(values.phone);
  const address = collapse(values.address);
  const city = collapse(values.city);
  const province = PROVINCES.find((p) => p.code === values.province)?.code ?? null;

  if (!name) errors.name = t('onboarding.nameRequired');
  else if (name.length > MAX_SHOP_NAME_LENGTH) errors.name = t('onboarding.nameTooLong');
  if (phone === 'invalid') errors.phone = t('onboarding.phoneInvalid');
  if (address.length > MAX_ADDRESS_LENGTH) errors.address = t('onboarding.addressTooLong');
  if (city.length > MAX_CITY_LENGTH) errors.city = t('onboarding.cityTooLong');
  if (values.province && !province) errors.province = t('onboarding.provinceInvalid');

  if (Object.keys(errors).length > 0 || phone === 'invalid') return { errors };
  return {
    input: { name, phone, address: address || null, city: city || null, province },
    errors,
  };
}
