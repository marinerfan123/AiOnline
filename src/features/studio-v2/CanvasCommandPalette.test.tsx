// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { CanvasCommandPalette, type CanvasCommand } from './CanvasCommandPalette';

const commands: CanvasCommand[] = [
  { id: 'add-prompt', label: '添加提示词', description: '创建一个 Prompt 节点', keywords: 'node create', action: vi.fn() },
  { id: 'fit-all', label: '适应全部', description: '将所有节点放入视口', keywords: 'view zoom', action: vi.fn() },
];

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

describe('CanvasCommandPalette', () => {
  it('filters commands and executes the highlighted result with Enter', () => {
    render(<CanvasCommandPalette open commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId('canvas-command-input');
    fireEvent.change(input, { target: { value: 'zoom' } });
    expect(screen.queryByTestId('canvas-command-add-prompt')).toBeNull();
    expect(screen.getByTestId('canvas-command-fit-all')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commands[1].action).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    render(<CanvasCommandPalette open commands={commands} onClose={onClose} />);
    const input = screen.getByTestId('canvas-command-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('canvas-command-palette-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab within the dialog and restores focus when closed', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(<CanvasCommandPalette open commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId('canvas-command-input');
    const lastCommand = screen.getByTestId('canvas-command-fit-all');

    lastCommand.focus();
    fireEvent.keyDown(lastCommand, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    rerender(<CanvasCommandPalette open={false} commands={commands} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
