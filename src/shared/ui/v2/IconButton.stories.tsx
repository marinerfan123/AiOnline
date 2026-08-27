import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconButton } from './IconButton';
import { Search, Plus, Settings, Trash2 } from 'lucide-react';

const meta: Meta<typeof IconButton> = {
  title: 'V2/IconButton',
  component: IconButton,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof IconButton>;

export const Default: Story = {
  render: (args) => <IconButton label="搜索" {...args}><Search className="size-4" /></IconButton>,
};

export const Sizes: Story = {
  render: () => (
    <div className="flex gap-2">
      <IconButton label="加" size="sm"><Plus className="size-3.5" /></IconButton>
      <IconButton label="设置"><Settings className="size-4" /></IconButton>
      <IconButton label="删除" className="text-ml2-danger hover:text-ml2-danger"><Trash2 className="size-4" /></IconButton>
      <IconButton label="加载中" loading />
    </div>
  ),
};
