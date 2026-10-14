import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useAdminI18n } from '../i18n';
import { formatNumber } from '../format';

interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  disabled?: boolean;
}

export const Pagination: React.FC<PaginationProps> = ({ total, limit, offset, onChange, disabled }) => {
  const { at, locale } = useAdminI18n();
  if (total === 0) return null;
  const first = offset + 1;
  const last = Math.min(offset + limit, total);

  return (
    <nav className="flex items-center justify-between gap-3 pt-3" aria-label={at('common.pagination')}>
      <p className="text-xs text-zinc-400" aria-live="polite">
        {at('common.pageOf', {
          from: formatNumber(first, locale),
          to: formatNumber(last, locale),
          total: formatNumber(total, locale),
        })}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={disabled || offset === 0}
          leftIcon={<ChevronLeft className="w-4 h-4" />}
        >
          {at('common.previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(offset + limit)}
          disabled={disabled || last >= total}
          rightIcon={<ChevronRight className="w-4 h-4" />}
        >
          {at('common.next')}
        </Button>
      </div>
    </nav>
  );
};
