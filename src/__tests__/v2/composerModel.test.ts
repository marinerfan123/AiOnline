import { describe, it, expect } from 'vitest';
import {
  deriveComposerState,
  detectSlashCommand,
  parseRefTokens,
  insertRefToken,
} from '@/features/studio-v2/composerModel';

describe('G07 composer model', () => {
  it('derives the six 02 §8 states from context', () => {
    expect(deriveComposerState({ selection: { count: 0 } })).toBe('NO_SELECTION');
    expect(deriveComposerState({ selection: { count: 1, nodeKind: 'image-generation' } })).toBe('NODE_SELECTED');
    expect(deriveComposerState({ selection: { count: 3 } })).toBe('MULTI_SELECTION');
    expect(deriveComposerState({ selection: { count: 1 }, toolSession: true })).toBe('TOOL_SESSION');
    expect(deriveComposerState({ selection: { count: 0 }, batch: true })).toBe('BATCH_RUN');
    expect(deriveComposerState({ selection: { count: 0 }, agentProposal: true })).toBe('AGENT_PROPOSAL');
  });

  it('detects a trailing slash command token', () => {
    const hit = detectSlashCommand('把这段文字优化 /optimize', ['optimize', 'translate', 'rewrite']);
    expect(hit).not.toBeNull();
    expect(hit!.slash).toBe('optimize');
    expect(hit!.pre).toBe('把这段文字优化 ');
  });

  it('returns null when there is no trailing slash token', () => {
    expect(detectSlashCommand('普通文本', ['optimize'])).toBeNull();
    expect(detectSlashCommand('text /', ['optimize'])).toBeNull(); // incomplete
  });

  it('parses @ mentions incl. bracket form with ranges', () => {
    const hits = parseRefTokens('让 @小美 在 @[咖啡馆 #2] 表演，参考 @Cafe');
    expect(hits.map((h) => h.token)).toEqual(['小美', '咖啡馆 #2', 'Cafe']);
    expect(hits[0].range.start).toBe(2);
    expect(hits[0].kind).toBe('word');
    expect(hits[1].kind).toBe('char');
  });

  it('inserts a reference chip at caret', () => {
    const out = insertRefToken('让  表演', 2, '小美');
    expect(out).toBe('让 @小美  表演');
  });
});
