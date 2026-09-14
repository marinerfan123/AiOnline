import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';
import { StatusBadge } from './StatusBadge';

const meta: Meta<typeof Badge> = {
  title: 'V2/Badge & StatusBadge',
  component: Badge,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Badge>;

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge tone="neutral">neutral</Badge>
      <Badge tone="accent">accent</Badge>
      <Badge tone="success">success</Badge>
      <Badge tone="warning">warning</Badge>
      <Badge tone="danger">danger</Badge>
      <Badge tone="info">info</Badge>
    </div>
  ),
};

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <StatusBadge status="queued" />
      <StatusBadge status="generating" />
      <StatusBadge status="processing" />
      <StatusBadge status="completed" />
      <StatusBadge status="failed" />
      <StatusBadge status="canceled" />
      <StatusBadge status="active" />
      <StatusBadge status="disabled" />
      <StatusBadge status="healthy" />
      <StatusBadge status="degraded" />
      <StatusBadge status="down" />
    </div>
  ),
};
