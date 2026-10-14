import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Spinner } from '../../components/ui/LoadingState';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { useAdminI18n } from '../i18n';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  className?: string;
}

export interface SortState {
  key: string;
  direction: 'ascending' | 'descending';
}

interface DataTableProps<T> {
  caption: string;
  /** Hide the caption visually while keeping it for screen readers. */
  hideCaption?: boolean;
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyMessage?: string;
  sort?: SortState | null;
  onSort?: (key: string) => void;
}

export function DataTable<T>({
  caption,
  hideCaption = false,
  columns,
  rows,
  rowKey,
  isLoading = false,
  error,
  onRetry,
  emptyMessage,
  sort,
  onSort,
}: DataTableProps<T>) {
  const { at } = useAdminI18n();

  if (error) {
    return (
      <ErrorMessage
        message={error}
        action={onRetry ? { label: at('common.retry'), onClick: onRetry } : undefined}
      />
    );
  }

  return (
    <div className="relative overflow-x-auto rounded-xl border border-zinc-800" aria-busy={isLoading}>
      <table className="w-full text-sm text-left">
        <caption className={hideCaption ? 'sr-only' : 'text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 px-3 py-2'}>
          {caption}
        </caption>
        <thead className="bg-zinc-900/80 text-xs text-zinc-400">
          <tr>
            {columns.map((col) => {
              const isSorted = sort?.key === col.key;
              const align = col.align === 'right' ? 'text-right' : 'text-left';
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={isSorted ? sort?.direction : col.sortable ? 'none' : undefined}
                  className={`px-3 py-2.5 font-medium whitespace-nowrap ${align}`}
                >
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                    >
                      {col.header}
                      {isSorted ? (
                        sort?.direction === 'ascending' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-50" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/80">
          {rows && rows.length > 0
            ? rows.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-zinc-900/60">
                  {columns.map((col, index) => {
                    const align = col.align === 'right' ? 'text-right tabular-nums' : 'text-left';
                    const content = col.render(row);
                    return index === 0 ? (
                      <th key={col.key} scope="row" className={`px-3 py-2.5 font-medium text-zinc-100 ${align} ${col.className ?? ''}`}>
                        {content}
                      </th>
                    ) : (
                      <td key={col.key} className={`px-3 py-2.5 text-zinc-300 ${align} ${col.className ?? ''}`}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))
            : !isLoading && (
                <tr>
                  <td colSpan={columns.length} className="px-3 py-8 text-center text-zinc-500">
                    {emptyMessage ?? at('common.empty')}
                  </td>
                </tr>
              )}
        </tbody>
      </table>
      {isLoading && (
        <div className={`flex justify-center ${rows && rows.length > 0 ? 'absolute inset-0 items-center bg-zinc-950/40' : 'py-8'}`}>
          <Spinner label={at('common.loading')} />
        </div>
      )}
    </div>
  );
}
