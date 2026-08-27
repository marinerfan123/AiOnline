import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog, DialogTrigger, DialogContent } from './Dialog';
import { Button } from './Button';

const meta: Meta<typeof Dialog> = {
  title: 'V2/Dialog',
  component: Dialog,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Dialog>;

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">打开 Dialog</Button>
      </DialogTrigger>
      <DialogContent title="示例标题">
        <p className="text-sm text-ml2-text-2">这是 V2 模态对话框内容。</p>
      </DialogContent>
    </Dialog>
  ),
};
