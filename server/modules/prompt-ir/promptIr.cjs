'use strict';
/**
 * W3-01 — Visual Intent / Prompt IR (intermediate representation) schema.
 *
 * The compiled pipeline input: carries a Shot's visual intent, camera, references, continuity
 * placeholders, DeliverySpec and policy metadata, with versioning. Pure module (no I/O) —
 * the Prompt Compiler (W3-02) consumes this IR.
 */

const IR_VERSION = 1;

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 400) : null; }

/** Build a Prompt IR from a Shot + DeliverySpec + references (pure). */
function buildPromptIr({ shot, deliverySpec, references = [], camera, intent } = {}) {
  const refs = (references || []).map((r) => ({
    type: str(r && r.type, 40),
    name: str(r && r.name, 200),
    id: r && r.id ? String(r.id) : null,
    role: str(r && r.role, 60),
  }));
  return {
    ir_version: IR_VERSION,
    shot: {
      shotId: shot && shot.id ? String(shot.id) : null,
      title: str(shot && shot.title, 200),
      seq: shot && shot.seq != null ? Number(shot.seq) : null,
      storyIntent: (shot && shot.storyIntent) || null,
      cinematography: (shot && shot.cinematography) || null,
      context: (shot && shot.context) || null,
    },
    intent: {
      subject: str(intent && intent.subject, 300),
      action: str(intent && intent.action, 200),
      mood: str(intent && intent.mood, 200),
      composition: str(intent && intent.composition, 200),
      keyVisuals: Array.isArray(intent && intent.keyVisuals) ? intent.keyVisuals.slice(0, 12) : [],
    },
    camera: {
      lens: str(camera && camera.lens, 80),
      angle: str(camera && camera.angle, 80),
      movement: str(camera && camera.movement, 120),
      shotSize: str(camera && camera.shotSize, 60),
    },
    references: refs,
    continuity: {
      placeholders: Array.isArray((shot && shot.context) ? shot.context.continuityPlaceholders : undefined)
        ? shot.context.continuityPlaceholders.slice(0, 30)
        : [],
      characterStates: Array.isArray((shot && shot.context) ? shot.context.characterStates : undefined)
        ? shot.context.characterStates.slice(0, 30)
        : [],
    },
    deliverySpec: {
      aspectRatio: str(deliverySpec && deliverySpec.aspect_ratio, 20) || str(deliverySpec && deliverySpec.aspectRatio, 20),
      resolution: str(deliverySpec && deliverySpec.resolution, 40),
      duration: deliverySpec && (deliverySpec.duration != null) ? Number(deliverySpec.duration) : null,
      fps: deliverySpec && (deliverySpec.fps != null) ? Number(deliverySpec.fps) : null,
      platform: str(deliverySpec && deliverySpec.platform, 30),
      subtitles: !!(deliverySpec && deliverySpec.subtitles),
      audio: deliverySpec && deliverySpec.audio != null ? str(deliverySpec.audio, 30) || null : null,
      safeArea: (deliverySpec && deliverySpec.safe_area) || null,
      variants: Array.isArray(deliverySpec && deliverySpec.variants) ? deliverySpec.variants.slice(0, 8) : [],
    },
    policy: {
      commercialApproved: false,
      license: null,
      minRights: null,
      allowedModels: [],
      maxBudget: null,
    },
  };
}

/** Validate a Prompt IR. Returns {ok, errors[]}. */
function validatePromptIr(ir) {
  const errors = [];
  if (!ir) { errors.push('ir required'); return { ok: false, errors }; }
  if (ir.ir_version !== IR_VERSION) errors.push(`ir_version must be ${IR_VERSION}`);
  if (!ir.shot || !ir.shot.shotId) errors.push('shot.shotId required');
  if (!Array.isArray(ir.references)) errors.push('references must be an array');
  if (!ir.deliverySpec || !ir.deliverySpec.aspectRatio) errors.push('deliverySpec.aspectRatio required');
  if (!ir.policy) errors.push('policy required');
  return { ok: errors.length === 0, errors };
}

module.exports = { IR_VERSION, buildPromptIr, validatePromptIr };
