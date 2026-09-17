// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NodeLibrary } from './NodeLibrary';

describe('NodeLibrary progressive disclosure', () => {
  afterEach(cleanup);

  it('removes the full footer in compact mode while preserving the toggle', () => {
    render(<NodeLibrary onAdd={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '收起节点库' });

    expect(screen.getByText(/节点来自 Node Registry/)).toBeTruthy();
    fireEvent.click(toggle);

    expect(screen.queryByText(/节点来自 Node Registry/)).toBeNull();
    expect(toggle.getAttribute('aria-label')).toBe('展开节点库');
  });
});
