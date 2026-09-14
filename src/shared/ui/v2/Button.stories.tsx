import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'V2/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'ghost', 'danger', 'destructive', 'outline'],
    },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    loading: { control: 'boolean' },
    asChild: { control: 'boolean' },
  },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { children: 'Primary' } };
export const Secondary: Story = { args: { variant: 'secondary', children: 'Secondary' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Ghost' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Danger' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Destructive' } };
export const Outline: Story = { args: { variant: 'outline', children: 'Outline' } };
export const Loading: Story = { args: { loading: true, children: 'Loading' } };
export const Disabled: Story = { args: { disabled: true, children: 'Disabled' } };
export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Button size="sm" {...args}>SM</Button>
      <Button size="md" {...args}>MD</Button>
      <Button size="lg" {...args}>LG</Button>
    </div>
  ),
  args: { children: '' },
};
