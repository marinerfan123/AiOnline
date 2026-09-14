import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipProvider, Tooltip as TooltipComp, TooltipTrigger, TooltipContent } from './Tooltip';
import { Popover as PopoverComp, PopoverTrigger, PopoverContent } from './Popover';
import { Button } from './Button';

const meta: Meta = {
  title: 'V2/Tooltip & Popover',
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={100}>
        <Story />
      </TooltipProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj;

export const TooltipStory: Story = {
  render: () => (
    <Button variant="secondary">
      悬停我
      <TooltipComp>
        <TooltipTrigger asChild>
          <span className="ml-1 inline-block">ⓘ</span>
        </TooltipTrigger>
        <TooltipContent>这是 V2 Tooltip</TooltipContent>
      </TooltipComp>
    </Button>
  ),
};

export const PopoverStory: Story = {
  render: () => (
    <PopoverComp>
      <PopoverTrigger asChild>
        <Button variant="secondary">打开 Popover</Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="text-sm text-ml2-text-2">Popover 内容：筛选器 / 菜单等浮层。</p>
      </PopoverContent>
    </PopoverComp>
  ),
};
