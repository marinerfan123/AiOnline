import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
import { Button } from './Button';

const meta: Meta<typeof Tabs> = {
  title: 'V2/Tabs',
  component: Tabs,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Tabs>;

function ControlledStory() {
  const [val, setVal] = useState('a');
  return (
    <div className="w-96">
      <Tabs value={val} onValueChange={setVal}>
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="mt-3 text-sm">Tab A</TabsContent>
        <TabsContent value="b" className="mt-3 text-sm">Tab B</TabsContent>
      </Tabs>
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => setVal(val === 'a' ? 'b' : 'a')}>
        程序切换
      </Button>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-96">
      <TabsList>
        <TabsTrigger value="overview">概览</TabsTrigger>
        <TabsTrigger value="settings">设置</TabsTrigger>
        <TabsTrigger value="logs">日志</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-3 text-sm text-ml2-text-2">概览内容</TabsContent>
      <TabsContent value="settings" className="mt-3 text-sm text-ml2-text-2">设置内容</TabsContent>
      <TabsContent value="logs" className="mt-3 text-sm text-ml2-text-2">日志内容</TabsContent>
    </Tabs>
  ),
};

export const Controlled: Story = { render: () => <ControlledStory /> };
