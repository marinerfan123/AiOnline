import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input, Textarea } from './Input';

const meta: Meta<typeof Input> = {
  title: 'V2/Input',
  component: Input,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = { args: { placeholder: '输入…' } };
export const Invalid: Story = { args: { placeholder: '无效值', invalid: true, value: 'bad' } };
export const Disabled: Story = { args: { placeholder: 'disabled', disabled: true } };
export const TextareaStory: Story = {
  render: () => <Textarea placeholder="多行…" rows={3} />,
};
