import { cn } from '@/lib/utils';
import { Skeleton } from './states';

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}

/** High-density data table shell (M00). No virtualization yet — added when a
 *  concrete admin module needs >100 rows (see 12-ui-rewrite-plan Phase F). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  className,
}: DataTableProps<T>) {
  const alignClass = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

  return (
    <div className={cn('overflow-x-auto rounded-lg border border-ml2-border', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-ml2-border bg-ml2-surface-2">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={cn('px-3 py-2 font-semibold text-ml2-text-3 text-xs whitespace-nowrap', alignClass(c.align))}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-ml2-border/50">
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2.5">
                    <Skeleton className="h-3.5 w-full max-w-24" />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-2">
                {empty ?? <div className="py-8 text-center text-xs text-ml2-text-3">暂无数据</div>}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-ml2-border/50 transition-colors last:border-0',
                  onRowClick && 'cursor-pointer hover:bg-ml2-surface-2',
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2.5 text-ml2-text', alignClass(c.align), c.className)}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
