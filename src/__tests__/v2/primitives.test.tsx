// @vitest-environment jsdom
/**
 * V2 M00 — core primitive render smoke (Button / Input / Badge / StatusBadge).
 * Guards: components mount without crashing and render their accessible bits.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { Badge } from '@/shared/ui/v2/Badge';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { Card, CardTitle } from '@/shared/ui/v2/Card';

// Vitest globals are off in this repo, so @testing-library/react's automatic
// cleanup does not register — clean up manually to avoid DOM leaking between tests.
afterEach(cleanup);

describe('V2 primitives render (M00)', () => {
  it('Button renders label and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);
    const btn = screen.getByRole('button', { name: '保存' });
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Button disabled blocks clicks', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>保存</Button>);
    const btn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Button loading disables the button', () => {
    render(<Button loading>生成中</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Input respects placeholder + invalid aria state', () => {
    render(<Input placeholder="输入邮箱" invalid />);
    const el = screen.getByPlaceholderText('输入邮箱');
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('Badge renders text', () => {
    render(<Badge tone="accent">NEW</Badge>);
    expect(screen.getByText('NEW')).toBeTruthy();
  });

  it('StatusBadge renders default + custom labels', () => {
    render(<StatusBadge status="generating" />);
    expect(screen.getByText('生成中')).toBeTruthy();
    render(<StatusBadge status="failed" label="任务失败" />);
    expect(screen.getByText('任务失败')).toBeTruthy();
  });

  it('Card composite renders title', () => {
    render(
      <Card>
        <CardTitle>卡片</CardTitle>
      </Card>,
    );
    expect(screen.getByText('卡片')).toBeTruthy();
  });
});
