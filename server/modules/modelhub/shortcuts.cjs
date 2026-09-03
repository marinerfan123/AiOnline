'use strict';
/**
 * G07 — Creative Slash Shortcut Registry (Blueprint 04 §6).
 * Server-configured (never hardcoded into node components). A shortcut maps a
 * slash token to executor (model|tool|workflow) with applicable node types and
 * required capabilities; executors are wired by later gates (G09 image tools /
 * G15 workflow) — the registry + query surface is the contract.
 */
const SHORTCUTS = Object.freeze([
  {
    id: 'shortcut-optimize', slash: 'optimize', version: 1,
    applicableNodeTypes: ['text', 'prompt', 'script'],
    requiredCapabilities: ['text.rewrite'], executor: 'model', config: {},
  },
  {
    id: 'shortcut-rewrite', slash: 'rewrite', version: 1,
    applicableNodeTypes: ['text', 'prompt', 'script'],
    requiredCapabilities: ['text.rewrite'], executor: 'model', config: {},
  },
  {
    id: 'shortcut-translate', slash: 'translate', version: 1,
    applicableNodeTypes: ['text', 'prompt', 'script'],
    requiredCapabilities: ['text.translate'], executor: 'model', config: {},
  },
  {
    id: 'shortcut-enhance', slash: 'enhance', version: 1,
    applicableNodeTypes: ['image', 'image-generation'],
    requiredCapabilities: ['image.enhance'], executor: 'tool', config: { tool: 'enhance' },
  },
  {
    id: 'shortcut-outpaint', slash: 'outpaint', version: 1,
    applicableNodeTypes: ['image', 'image-generation'],
    requiredCapabilities: ['image.outpaint'], executor: 'tool', config: { tool: 'outpaint' },
  },
  {
    id: 'shortcut-remove-bg', slash: 'remove-bg', version: 1,
    applicableNodeTypes: ['image', 'image-generation'],
    requiredCapabilities: ['image.backgroundRemove'], executor: 'tool', config: { tool: 'background-remove' },
  },
]);

function listShortcuts({ nodeType } = {}) {
  if (!nodeType) return SHORTCUTS.map((s) => ({ ...s }));
  return SHORTCUTS.filter((s) => s.applicableNodeTypes.includes(nodeType)).map((s) => ({ ...s }));
}

function getShortcut(slash) {
  return SHORTCUTS.find((s) => s.slash === slash) || null;
}

module.exports = { SHORTCUTS, listShortcuts, getShortcut };
