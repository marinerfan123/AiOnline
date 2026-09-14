import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from './Select';

const meta: Meta<typeof Select> = {
  title: 'V2/Select',
  component: Select,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Select>;

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
];

export const Default: Story = { args: { options, placeholder: '选择一个' } };
export const Controlled: Story = { args: { options, value: 'b' } };
