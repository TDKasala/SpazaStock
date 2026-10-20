import React, { useEffect, useState } from 'react';
import { Plus, ScanLine } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { BarcodeScannerModal } from '../../components/scanner/BarcodeScannerModal';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminI18n } from '../i18n';
import { adminHref, navigateAdmin, useAdminRoute } from '../router';
import { useAdminQuery } from '../useAdminQuery';
import type { CatalogAdminProduct } from '../types';
import { DataTable, type Column } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { AdminLink } from '../components/AdminLink';
import { PageHeader, QueryError, fieldClass } from '../components/PageParts';

const PAGE_SIZE = 25;

function filtersFrom(params: URLSearchParams) {
  return {
    search: params.get('q') ?? '',
    offset: Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0),
  };
}

function hrefFor(filters: { search: string; offset: number }) {
  return adminHref('catalog', {
    params: {
      q: filters.search,
      offset: filters.offset ? String(filters.offset) : null,
    },
  });
}

export const CatalogPage: React.FC = () => {
  const { at, label } = useAdminI18n();
  const route = useAdminRoute();
  const filters = filtersFrom(route.params);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [scanning, setScanning] = useState(false);

  useEffect(() => setSearchDraft(filters.search), [filters.search]);

  const catalog = useAdminQuery(hrefFor(filters), () => adminApi.searchCatalog(filters.search, PAGE_SIZE, filters.offset));

  const update = (patch: Partial<{ search: string; offset: number }>) =>
    navigateAdmin(hrefFor({ ...filters, offset: 0, ...patch }), { replace: true });

  const columns: Column<CatalogAdminProduct>[] = [
    {
      key: 'name',
      header: at('catalog.name'),
      render: (row) => (
        <AdminLink href={adminHref('catalog', { catalogId: row.id })} className="text-emerald-300 hover:underline">
          {row.name}
        </AdminLink>
      ),
    },
    {
      key: 'brand',
      header: at('catalog.brand'),
      render: (row) => row.brand ?? at('common.none'),
    },
    {
      key: 'category',
      header: at('catalog.category'),
      render: (row) => label('categories', row.category),
    },
    {
      key: 'package',
      header: at('catalog.packageSize'),
      render: (row) => row.package_size ?? at('common.none'),
    },
    {
      key: 'verification',
      header: at('catalog.verification'),
      render: (row) => label('verification', row.verification_status),
    },
    {
      key: 'barcodes',
      header: at('catalog.barcodes'),
      align: 'right',
      render: (row) => String(row.barcodes?.length ?? 0),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={at('catalog.title')}
        description={at('catalog.description')}
        actions={
          <Button
            size="sm"
            leftIcon={<Plus className="w-4 h-4" />}
            onClick={() => navigateAdmin(adminHref('catalog', { catalogId: 'new' }))}
          >
            {at('catalog.create')}
          </Button>
        }
      />

      <form
        className="flex flex-wrap gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          update({ search: searchDraft.trim() });
        }}
      >
        <label htmlFor="catalog-search" className="sr-only">
          {at('catalog.search')}
        </label>
        <input
          id="catalog-search"
          type="search"
          value={searchDraft}
          maxLength={80}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder={at('catalog.searchPlaceholder')}
          className={`${fieldClass} max-w-md`}
        />
        <Button type="submit" variant="secondary" size="sm">
          {at('catalog.search')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<ScanLine className="w-4 h-4" />}
          onClick={() => setScanning(true)}
        >
          {at('catalog.scan')}
        </Button>
      </form>

      {catalog.error ? (
        <QueryError message={adminErrorMessage(catalog.error, at)} onRetry={catalog.reload} />
      ) : (
        <>
          <DataTable
            caption={at('catalog.caption')}
            columns={columns}
            rows={catalog.data?.rows ?? null}
            rowKey={(row) => row.id}
            isLoading={catalog.isLoading}
            emptyMessage={at('catalog.empty')}
          />
          <Pagination
            total={catalog.data?.total ?? 0}
            limit={PAGE_SIZE}
            offset={filters.offset}
            onChange={(offset) => update({ offset, search: filters.search })}
            disabled={catalog.isLoading}
          />
        </>
      )}

      <BarcodeScannerModal
        isOpen={scanning}
        onClose={() => setScanning(false)}
        title={at('catalog.scan')}
        onBarcodeScanned={(barcode) => {
          setScanning(false);
          setSearchDraft(barcode);
          update({ search: barcode });
        }}
      />
    </div>
  );
};
