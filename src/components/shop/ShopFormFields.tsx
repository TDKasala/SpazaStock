import React from 'react';
import { MapPin, Phone, Store } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Input } from '../ui/Input';
import {
  MAX_ADDRESS_LENGTH,
  MAX_CITY_LENGTH,
  MAX_SHOP_NAME_LENGTH,
  PROVINCES,
  type ShopFormErrors,
  type ShopFormValues,
} from '../../lib/shopDetails';

export interface ShopFormFieldsProps {
  values: ShopFormValues;
  errors: ShopFormErrors;
  onChange: (values: ShopFormValues) => void;
  autoFocusName?: boolean;
}

/** Name plus the optional contact details of a new shop. */
export const ShopFormFields: React.FC<ShopFormFieldsProps> = ({ values, errors, onChange, autoFocusName }) => {
  const { t } = useLanguage();
  const set = <K extends keyof ShopFormValues>(key: K, value: ShopFormValues[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <>
      <Input
        id="shop-name"
        label={t('onboarding.nameLabel')}
        placeholder={t('onboarding.namePlaceholder')}
        value={values.name}
        onChange={(e) => set('name', e.target.value)}
        error={errors.name}
        maxLength={MAX_SHOP_NAME_LENGTH}
        leftIcon={<Store className="w-4 h-4 text-emerald-400" />}
        autoFocus={autoFocusName}
        required
      />

      <p className="text-xs text-zinc-400">{t('onboarding.detailsHint')}</p>

      <Input
        id="shop-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        label={t('onboarding.phoneLabel')}
        placeholder="082 123 4567"
        value={values.phone}
        onChange={(e) => set('phone', e.target.value)}
        error={errors.phone}
        maxLength={24}
        leftIcon={<Phone className="w-4 h-4 text-emerald-400" />}
      />

      <Input
        id="shop-address"
        autoComplete="street-address"
        label={t('onboarding.addressLabel')}
        placeholder={t('onboarding.addressPlaceholder')}
        value={values.address}
        onChange={(e) => set('address', e.target.value)}
        error={errors.address}
        maxLength={MAX_ADDRESS_LENGTH}
        leftIcon={<MapPin className="w-4 h-4 text-emerald-400" />}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          id="shop-city"
          autoComplete="address-level2"
          label={t('onboarding.cityLabel')}
          placeholder={t('onboarding.cityPlaceholder')}
          value={values.city}
          onChange={(e) => set('city', e.target.value)}
          error={errors.city}
          maxLength={MAX_CITY_LENGTH}
        />

        <div className="flex flex-col gap-1.5 text-left">
          <label htmlFor="shop-province" className="text-xs font-medium text-zinc-300">
            {t('onboarding.provinceLabel')}
          </label>
          <select
            id="shop-province"
            value={values.province}
            onChange={(e) => set('province', e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-3.5 py-3 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 min-h-[46px]"
          >
            <option value="">{t('onboarding.provinceNone')}</option>
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
          {errors.province && <span className="text-xs text-rose-400">{errors.province}</span>}
        </div>
      </div>
    </>
  );
};
