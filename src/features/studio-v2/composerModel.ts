// G07 — Bottom Prompt Composer model (Blueprint 02 §8, pure logic).
// Composer state machine + slash command + @reference token parsing.
// UI-independent so it is unit-testable and shared by any surface
// (canvas composer / CLI / agent proposal).

export type ComposerState =
  | 'NO_SELECTION'
  | 'NODE_SELECTED'
  | 'MULTI_SELECTION'
  | 'TOOL_SESSION'
  | 'BATCH_RUN'
  | 'AGENT_PROPOSAL';

export type ComposerMode = 'idle' | 'prompting' | 'generating' | 'tool';

export interface ComposerContext {
  selection: { count: number; nodeKind?: string };
  toolSession?: boolean;
  batch?: boolean;
  agentProposal?: boolean;
}

/** Derive the composer state from the current canvas context (02 §8). */
export function deriveComposerState(ctx: ComposerContext): ComposerState {
  if (ctx.agentProposal) return 'AGENT_PROPOSAL';
  if (ctx.batch) return 'BATCH_RUN';
  if (ctx.toolSession) return 'TOOL_SESSION';
  if (ctx.selection.count === 0) return 'NO_SELECTION';
  if (ctx.selection.count === 1) return 'NODE_SELECTED';
  return 'MULTI_SELECTION';
}

export interface SlashCommandHit {
  slash: string;
  /** chars before the slash (e.g. '@Alice 把这段 /optimize') */
  pre: string;
  range: { start: number; end: number };
}

/**
 * Detect a trailing slash command while typing (e.g. "prompt text /opti…").
 * Returns the matched command token when the caret is at the end of the line
 * and the token after the last whitespace starts with "/".
 */
export function detectSlashCommand(text: string, slashNames: string[]): SlashCommandHit | null {
  if (!text.endsWith(' ')) {
    const m = text.match(/(^|\s)(\/[a-zA-Z0-9_-]+)$/);
    if (!m) return null;
    const slash = m[2].slice(1);
    const start = text.length - slash.length - 1;
    return { slash, pre: text.slice(0, start).replace(/\/$/, ''), range: { start, end: text.length } };
  }
  return null;
}

export interface RefTokenHit {
  token: string; // without leading @
  range: { start: number; end: number };
  kind: 'char' | 'word' | 'asset';
}

const REF_NAME = /[^\s@,.!?;:"'()[\]]+/;
const WORD = /^[a-zA-Z0-9_\u4e00-\u9fff-]+$/;

/**
 * AutoLink (@) token parsing (04 §13): returns every @ mention with range, so
 * the UI can render chips and the resolver can bind entities. Ambiguity is the
 * resolver's job; parsing is deterministic here.
 */
export function parseRefTokens(text: string): RefTokenHit[] {
  const hits: RefTokenHit[] = [];
  const re = /@(?:\[([^\]]+)\]|([^\s@,.!?;:"'()[\]]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    const start = m.index;
    const kind: RefTokenHit['kind'] = WORD.test(raw) ? 'word' : 'char';
    hits.push({ token: raw, range: { start, end: start + raw.length + 1 }, kind });
  }
  return hits;
}

/** Insert a reference chip token at a caret position (draft helper). */
export function insertRefToken(text: string, caret: number, entityName: string): string {
  const token = `@${entityName} `;
  return text.slice(0, caret) + token + text.slice(caret);
}

/** Model payload shape from GET /api/studio/models (bindings-aware view). */
export interface ModelAvailability {
  /** canonical capability → actually dispatchable (enabled provider + key line). */
  available?: Record<string, boolean>;
  /** canonical capabilities projection (booleans + numeric limits). */
  capabilities?: Record<string, boolean | number>;
}

/**
 * Is a model actually usable for at least one wanted canonical capability?
 * Trusts the server's bindings-aware `available` field when present (真实派发面:
 * provider_model_bindings 多线路 + provider.enabled + api_keys); falls back to
 * the legacy capabilities boolean when the field is absent (older API shape).
 */
export function isModelAvailableFor(model: ModelAvailability, wanted: string[]): boolean {
  if (model.available && typeof model.available === 'object') {
    return wanted.some((w) => model.available![w] === true);
  }
  return wanted.some((w) => model.capabilities?.[w] === true);
}

/** Filter a model list down to those usable for at least one wanted capability. */
export function filterAvailableModels<T extends ModelAvailability>(models: T[], wanted: string[]): T[] {
  return models.filter((m) => isModelAvailableFor(m, wanted));
}
