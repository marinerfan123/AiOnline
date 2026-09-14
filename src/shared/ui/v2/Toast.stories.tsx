import type { Meta, StoryObj } from '@storybook/react-vite';
import { toast, V2Toaster } from './Toast';
import { Button } from './Button';

const meta: Meta = {
  title: 'V2/Toast',
  tags: ['autodocs'],
  decorators: [(Story) => (
    <div className="space-y-4">
      <Story />
      <V2Toaster />
    </div>
  )],
};
export default meta;
type Story = StoryObj;

export const FireToasts: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => toast('普通消息')}>plain</Button>
      <Button variant="secondary" size="sm" onClick={() => toast.success('操作成功')}>success</Button>
      <Button variant="secondary" size="sm" onClick={() => toast.error('操作失败')}>error</Button>
    </div>
  ),
};
