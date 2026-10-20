import React, { useEffect, useState } from 'react';
import { ScanLine, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { BarcodeScannerModal } from '../../components/scanner/BarcodeScannerModal';
import { PRODUCT_CATEGORIES } from '../../components/stock/ProductFormFields';
import type { ProductCategory } from '../../types';
import { ImageCompressionError, compressProductImage, type CompressedImage } from '../../lib/imageCompression';
import { getSupabase } from '../../lib/supabase';
import { adminApi, adminErrorMessage, uploadCatalogImage } from '../api';
import { useAdminI18n } from '../i18n';
import { adminHref, navigateAdmin } from '../router';
import { useAdminQuery } from '../useAdminQuery';
import type { CatalogBarcodeKind, CatalogVerification } from '../types';
import { selectClass } from '../components/DateRangeFilter';
import { ReasonConfirmDialog } from '../components/ReasonConfirmDialog';
import { AdminLink } from '../components/AdminLink';
import { Field, PageHeader, QueryError, Section, fieldClass } from '../components/PageParts';

const VERIFICATION: readonly CatalogVerification[] = ['verified', 'user_submitted', 'external'];
const KINDS: readonly CatalogBarcodeKind[] = ['unit', 'alternate', 'pack'];
const IMAGE_BUCKET = 'product-images';

function imageErrorText(code: string, at: (key: string) => string): string {
  switch (code) {
    case 'unsupported':
      return at('catalog.imageErrors.unsupported');
    case 'too_large':
      return at('catalog.imageErrors.too_large');
    case 'still_too_large':
      return at('catalog.imageErrors.still_too_large');
    default:
      return at('catalog.imageErrors.decode_failed');
  }
}

interface Draft {
  name: string;
  brand: string;
  category: ProductCategory;
  packageSize: string;
  packageQuantity: string;
  packageUnit: string;
  verification: CatalogVerification;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  brand: '',
  category: 'groceries',
  packageSize: '',
  packageQuantity: '',
  packageUnit: '',
  verification: 'verified',
};

type Pending =
  | { kind: 'save' }
  | { kind: 'barcode' }
  | { kind: 'unlink'; barcode: string }
  | { kind: 'image'; image: CompressedImage }
  | { kind: 'clear-image' };

function useStoredImage(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    let active = true;
    let objectUrl: string | null = null;
    void supabase.storage
      .from(IMAGE_BUCKET)
      .download(path)
      .then(({ data }) => {
        if (!active || !data) return;
        objectUrl = URL.createObjectURL(data);
        setUrl(objectUrl);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}

export const CatalogEditorPage: React.FC<{ catalogId: string }> = ({ catalogId }) => {
  const { at, label } = useAdminI18n();
  const isNew = catalogId === 'new';
  const loaded = useAdminQuery(isNew ? 'catalog:new' : `catalog:${catalogId}`, () =>
    isNew ? Promise.resolve(null) : adminApi.getCatalogProduct(catalogId)
  );
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [barcode, setBarcode] = useState('');
  const [kind, setKind] = useState<CatalogBarcodeKind>('unit');
  const [units, setUnits] = useState('6');
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const savedPath = loaded.data?.product.image_path ?? null;
  const storedPreview = useStoredImage(localPreview ? null : savedPath);

  useEffect(() => {
    const product = loaded.data?.product;
    if (!product) return;
    setDraft({
      name: product.name,
      brand: product.brand ?? '',
      category: (PRODUCT_CATEGORIES as readonly string[]).includes(product.category)
        ? (product.category as ProductCategory)
        : 'other',
      packageSize: product.package_size ?? '',
      packageQuantity: product.package_quantity == null ? '' : String(product.package_quantity),
      packageUnit: product.package_unit ?? '',
      verification: product.verification_status,
    });
  }, [loaded.data]);

  useEffect(() => {
    if (!localPreview) return;
    return () => URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const quantity = () => {
    const text = draft.packageQuantity.trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value;
  };

  const openSave = () => {
    setFormError(null);
    if (!draft.name.trim()) {
      setFormError(at('catalog.nameRequired'));
      return;
    }
    if (quantity() === undefined) {
      setFormError(at('catalog.quantityInvalid'));
      return;
    }
    setPending({ kind: 'save' });
  };

  const confirm = async (reason: string) => {
    if (!pending) return;
    if (pending.kind === 'save') {
      const packageQuantity = quantity();
      const saved = await adminApi.saveCatalogProduct(
        {
          id: isNew ? null : catalogId,
          name: draft.name.trim(),
          brand: draft.brand.trim(),
          category: draft.category,
          packageSize: draft.packageSize.trim(),
          packageQuantity: packageQuantity ?? null,
          packageUnit: draft.packageUnit.trim(),
          verificationStatus: isNew ? 'verified' : draft.verification,
        },
        reason
      );
      setPending(null);
      setNotice(at('catalog.saved'));
      if (isNew) navigateAdmin(adminHref('catalog', { catalogId: saved.id }), { replace: true });
      else loaded.reload();
      return;
    }
    if (pending.kind === 'barcode') {
      await adminApi.linkCatalogBarcode(
        catalogId,
        barcode.trim(),
        kind,
        kind === 'pack' ? Number(units) : null,
        reason
      );
      setBarcode('');
      setPending(null);
      setNotice(at('catalog.barcodeSaved'));
      loaded.reload();
      return;
    }
    if (pending.kind === 'unlink') {
      await adminApi.unlinkCatalogBarcode(pending.barcode, reason);
      setPending(null);
      setNotice(at('catalog.barcodeRemoved'));
      loaded.reload();
      return;
    }
    if (pending.kind === 'image') {
      const path = await uploadCatalogImage(catalogId, pending.image);
      await adminApi.setCatalogImage(catalogId, path, reason);
      setLocalPreview(null);
      setPending(null);
      setNotice(at('catalog.imageSaved'));
      loaded.reload();
      return;
    }
    await adminApi.setCatalogImage(catalogId, null, reason);
    setPending(null);
    setNotice(at('catalog.imageCleared'));
    loaded.reload();
  };

  const onImage = async (file: File | undefined) => {
    if (!file) return;
    setImageError(null);
    try {
      const image = await compressProductImage(file);
      setLocalPreview(URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType })));
      setPending({ kind: 'image', image });
    } catch (err) {
      const code = err instanceof ImageCompressionError ? err.code : 'decode_failed';
      setImageError(imageErrorText(code, at));
    }
  };

  const preview = localPreview ?? storedPreview;
  const barcodes = loaded.data?.barcodes ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={isNew ? at('catalog.createTitle') : at('catalog.editorTitle')}
        description={isNew ? at('catalog.createDescription') : at('catalog.editorDescription')}
        actions={
          <AdminLink href={adminHref('catalog')} className="text-sm text-emerald-300 hover:underline">
            {at('catalog.back')}
          </AdminLink>
        }
      />

      {loaded.error ? (
        <QueryError message={adminErrorMessage(loaded.error, at)} onRetry={loaded.reload} />
      ) : (
        <>
          {notice && (
            <p role="status" className="text-sm text-emerald-300">
              {notice}
            </p>
          )}
          {formError && <ErrorMessage message={formError} />}

          <Section title={at('catalog.details')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field id="catalog-name" label={at('catalog.name')}>
                <input
                  id="catalog-name"
                  value={draft.name}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className={fieldClass}
                />
              </Field>
              <Field id="catalog-brand" label={at('catalog.brand')}>
                <input
                  id="catalog-brand"
                  value={draft.brand}
                  maxLength={80}
                  onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
                  className={fieldClass}
                />
              </Field>
              <Field id="catalog-category" label={at('catalog.category')}>
                <select
                  id="catalog-category"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as ProductCategory })}
                  className={selectClass}
                >
                  {PRODUCT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {label('categories', category)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="catalog-verification" label={at('catalog.verification')}>
                <select
                  id="catalog-verification"
                  value={draft.verification}
                  disabled={isNew}
                  onChange={(e) => setDraft({ ...draft, verification: e.target.value as CatalogVerification })}
                  className={selectClass}
                >
                  {VERIFICATION.map((status) => (
                    <option key={status} value={status}>
                      {label('verification', status)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="catalog-package-size" label={at('catalog.packageSize')}>
                <input
                  id="catalog-package-size"
                  value={draft.packageSize}
                  maxLength={40}
                  onChange={(e) => setDraft({ ...draft, packageSize: e.target.value })}
                  className={fieldClass}
                />
              </Field>
              <Field id="catalog-package-quantity" label={at('catalog.packageQuantity')}>
                <input
                  id="catalog-package-quantity"
                  inputMode="decimal"
                  value={draft.packageQuantity}
                  onChange={(e) => setDraft({ ...draft, packageQuantity: e.target.value })}
                  className={fieldClass}
                />
              </Field>
              <Field id="catalog-package-unit" label={at('catalog.packageUnit')}>
                <input
                  id="catalog-package-unit"
                  value={draft.packageUnit}
                  maxLength={16}
                  onChange={(e) => setDraft({ ...draft, packageUnit: e.target.value })}
                  className={fieldClass}
                />
              </Field>
            </div>
            <Button type="button" onClick={openSave}>
              {at('catalog.save')}
            </Button>
          </Section>

          {!isNew && (
            <Section title={at('catalog.barcodes')} description={at('catalog.barcodesHint')}>
              {barcodes.length === 0 ? (
                <p className="text-sm text-zinc-400">{at('catalog.noBarcodes')}</p>
              ) : (
                <ul className="divide-y divide-zinc-800 text-sm">
                  {barcodes.map((row) => (
                    <li key={row.barcode} className="flex items-center justify-between gap-3 py-2">
                      <span>
                        <span className="font-mono text-zinc-100">{row.barcode}</span>
                        <span className="ml-2 text-zinc-400">
                          {label('barcodeKinds', row.kind)}
                          {row.kind === 'pack' && row.units_per_package ? ` · ${row.units_per_package}` : ''}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={at('catalog.removeBarcode')}
                        onClick={() => setPending({ kind: 'unlink', barcode: row.barcode })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                <Field id="catalog-barcode" label={at('catalog.barcode')}>
                  <input
                    id="catalog-barcode"
                    value={barcode}
                    maxLength={64}
                    onChange={(e) => setBarcode(e.target.value)}
                    className={fieldClass}
                  />
                </Field>
                <Field id="catalog-kind" label={at('catalog.kind')}>
                  <select
                    id="catalog-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as CatalogBarcodeKind)}
                    className={selectClass}
                  >
                    {KINDS.map((value) => (
                      <option key={value} value={value}>
                        {label('barcodeKinds', value)}
                      </option>
                    ))}
                  </select>
                </Field>
                {kind === 'pack' && (
                  <Field id="catalog-units" label={at('catalog.units')}>
                    <input
                      id="catalog-units"
                      inputMode="numeric"
                      value={units}
                      onChange={(e) => setUnits(e.target.value)}
                      className={`${fieldClass} w-24`}
                    />
                  </Field>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    leftIcon={<ScanLine className="w-4 h-4" />}
                    onClick={() => setScanning(true)}
                  >
                    {at('catalog.scan')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!barcode.trim()}
                    onClick={() => setPending({ kind: 'barcode' })}
                  >
                    {at('catalog.addBarcode')}
                  </Button>
                </div>
              </div>
            </Section>
          )}

          {!isNew && (
            <Section title={at('catalog.image')} description={at('catalog.imageHint')}>
              {preview && (
                <img src={preview} alt="" className="w-24 h-24 rounded-xl object-cover bg-zinc-800" />
              )}
              {imageError && <ErrorMessage message={imageError} />}
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-700 text-sm cursor-pointer hover:border-zinc-500">
                  {at('catalog.chooseImage')}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      void onImage(file);
                    }}
                  />
                </label>
                {savedPath && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending({ kind: 'clear-image' })}>
                    {at('catalog.removeImage')}
                  </Button>
                )}
              </div>
            </Section>
          )}
        </>
      )}

      <BarcodeScannerModal
        isOpen={scanning}
        onClose={() => setScanning(false)}
        title={at('catalog.scan')}
        onBarcodeScanned={(code) => {
          setScanning(false);
          setBarcode(code);
        }}
      />

      <ReasonConfirmDialog
        isOpen={pending !== null}
        title={at('catalog.confirmTitle')}
        description={at('catalog.confirmDescription')}
        confirmLabel={at('catalog.confirm')}
        onConfirm={confirm}
        onClose={() => setPending(null)}
      />
    </div>
  );
};
