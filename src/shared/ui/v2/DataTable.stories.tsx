import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DataTable, type Column } from './DataTable';
import { StatusBadge } from './StatusBadge';

const meta: Meta = {
  title: 'V2/DataTable',
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

interface Row {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'generating';
  credits: number;
}

const rows: Row[] = [
  { id: '1', name: '任务 Alpha', status: 'completed', credits: 12 },
  { id: '2', name: '任务 Bravo', status: 'generating', credits: 8 },
  { id: '3', name: '任务 Charlie', status: 'failed', credits: 0 },
];

const columns: Column<Row>[] = [
  { key: 'name', header: '名称', render: (r) => r.name },
  { key: 'status', header: '状态', render: (r) => <StatusBadge status={r.status} /> },
  { key: 'credits', header: '积分', align: 'right', render: (r) => r.credits },
];

function RowClickStory() {
  const [sel, setSel] = useState<Row | null>(null);
  return (
    <div className="space-y-3">
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => setSel(r)} />
      <p className="text-xs text-ml2-text-3">已选择: {sel?.name ?? '无'}</p>
    </div>
  );
}

export const Default: Story = {
  render: () => <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />,
};

export const Loading: Story = {
  render: () => <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading />,
};

export const Empty: Story = {
  render: () => (
    <DataTable
      columns={columns}
      rows={[]}
      rowKey={(r) => r.id}
      empty={<div className="p-6 text-center text-sm text-ml2-text-3">暂无数据</div>}
    />
  ),
};

export const RowClick: Story = { render: () => <RowClickStory /> };
