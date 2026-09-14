import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './Button';

const meta: Meta = {
  title: 'V2/ConfirmDialog',
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

function DefaultStory() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button variant="secondary" onClick={() => setOpen(true)}>打开确认框</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="确认操作？"
        description="此操作将立即执行。"
        onConfirm={() => {
          setOpen(false);
          alert('confirmed');
        }}
      />
      <p className="text-xs text-ml2-text-3">提示: alert 为 story 演示用</p>
    </div>
  );
}

function DangerStory() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button variant="danger" onClick={() => setOpen(true)}>删除</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="删除该资产？"
        description="删除后不可恢复。"
        confirmLabel="永久删除"
        tone="danger"
        onConfirm={() => setOpen(false)}
      />
    </div>
  );
}

export const Default: Story = { render: () => <DefaultStory /> };
export const Danger: Story = { render: () => <DangerStory /> };
