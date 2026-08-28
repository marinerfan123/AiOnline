// M05-A — Studio Canvas core types.
// Contract-first: canvas nodes reference assets ONLY via assetId (AssetRef).
// Never base64, never signed URLs as identity, never local paths.

export type PortType =
  | 'TEXT'
  | 'SCRIPT'
  | 'CHARACTER'
  | 'IMAGE'
  | 'IMAGE_SET'
  | 'VIDEO'
  | 'AUDIO'
  | 'REFERENCE'
  | 'SHOT'
  | 'SCENE'
  | 'JSON';

export type NodeCategory = 'Input' | 'Creative' | 'Media' | 'Output' | 'Structure';

export type StudioNodeKind =
  | 'prompt'
  | 'reference'
  | 'image'
  | 'video'
  | 'output'
  | 'script'
  | 'frame';

export type NodeRuntimeStatus =
  | 'idle'
  | 'ready'
  | 'generating'
  | 'error'
  | 'disabled'
  | 'stale';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  /** true = input (target), false = output (source) */
  input: boolean;
}

export interface StudioNodeData extends Record<string, unknown> {
  nodeKind: StudioNodeKind;
  title: string;
  status: NodeRuntimeStatus;
  /** M04-S Asset identity (permanent). Display URLs are resolved at render time. */
  assetId?: string | null;
  prompt?: string;
  /** frame/group bookkeeping */
  frameLabel?: string;
}

export interface StudioEdgeData extends Record<string, unknown> {
  portType: PortType;
}

/** Stable node id minting — new ids on paste/duplicate, never reuse old ids. */
export function mintNodeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
