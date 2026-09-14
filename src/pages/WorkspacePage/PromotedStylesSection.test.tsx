// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PromotedStylesSection } from './PromotedStylesSection';
import type { ReferenceStyle } from '@/services/api';

beforeAll(() => {
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');
});

afterEach(cleanup);

const styles: ReferenceStyle[] = [{
  id: 'style-1',
  name: '网球发球抓拍',
  description: '高速快门与硬光质感',
  previewUrl: 'https://example.test/preview.jpg',
  fullUrl: 'https://example.test/full.jpg',
  userDisplayName: '设计师甲',
}];

describe('PromotedStylesSection', () => {
  it('以紧凑卡片展示，并可通过开关隐藏和恢复精选', () => {
    render(<PromotedStylesSection styles={styles} onUse={vi.fn()} />);

    expect(screen.getByRole('switch', { name: '显示精选推广样式' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('网球发球抓拍')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: '显示精选推广样式' }));
    expect(screen.queryByText('网球发球抓拍')).toBeNull();
    expect(screen.getByText('精选已隐藏')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: '显示精选推广样式' }));
    expect(screen.getByText('网球发球抓拍')).toBeTruthy();
  });

  it('点击预览打开大图详情，创作按钮仍调用原动作', () => {
    const onUse = vi.fn();
    render(<PromotedStylesSection styles={styles} onUse={onUse} />);

    fireEvent.click(screen.getByRole('button', { name: '查看网球发球抓拍' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('高速快门与硬光质感')).toBeTruthy();
    expect(screen.getByRole('img', { name: '网球发球抓拍' }).getAttribute('src')).toBe('https://example.test/full.jpg');

    fireEvent.click(screen.getByRole('button', { name: '用此样式创作' }));
    expect(onUse).toHaveBeenCalledWith(styles[0]);
  });
});
