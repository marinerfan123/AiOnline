import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DrawerContent, Drawer } from './Drawer';
import { Button } from './Button';

const meta: Meta<typeof Drawer> = {
  title: 'V2/Drawer',
  component: Drawer,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Drawer>;

function Controlled({ side, label }: { side: 'right' | 'left' | 'bottom'; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-3">
      <Button variant="secondary" onClick={() => setOpen(true)}>{label}</Button>
      <DrawerContent side={side} open={open} onOpenChange={setOpen} title={label}>
        <p className="text-sm text-ml2-text-2">{side} 滑入的面板内容（settings / filters 场景）。</p>
      </DrawerContent>
    </div>
  );
}

export const Right: Story = { render: () => <Controlled side="right" label="右侧 Drawer" /> };
export const Left: Story = { render: () => <Controlled side="left" label="左侧 Drawer" /> };
export const Bottom: Story = { render: () => <Controlled side="bottom" label="底部 Drawer" /> };
