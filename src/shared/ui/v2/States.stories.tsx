import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState, LoadingState, ErrorState, Skeleton } from './states';
import { Inbox } from 'lucide-react';

const meta: Meta = {
  title: 'V2/States',
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => (
    <EmptyState
      icon={Inbox}
      title="空状态"
      description="这里还没有任何内容。"
      action={{ label: '新建', onClick: () => {} }}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="space-y-4">
      <LoadingState label="加载中…" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  ),
};

export const Error: Story = {
  render: () => (
    <ErrorState
      title="出错了"
      description="请求失败，请稍后重试。"
      onRetry={() => {}}
    />
  ),
};
