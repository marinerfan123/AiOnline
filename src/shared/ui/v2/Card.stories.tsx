import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Panel } from './Card';
import { Button } from './Button';

const meta: Meta<typeof Card> = {
  title: 'V2/Card',
  component: Card,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>卡片标题</CardTitle>
        <CardDescription>卡片描述文字，用于补充说明。</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-ml2-text-2">
        内容区：高信息密度排布。
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button size="sm" variant="ghost">取消</Button>
        <Button size="sm">确认</Button>
      </CardFooter>
    </Card>
  ),
};

export const PanelAlias: Story = {
  render: () => (
    <Panel className="w-80 p-4">
      <p className="text-sm">Panel = Card 别名，供面板型组件复用。</p>
    </Panel>
  ),
};
