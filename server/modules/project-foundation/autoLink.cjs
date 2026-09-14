'use strict';
/**
 * G07 — AutoLink Reference Resolver (Blueprint 04 §13, pure-ish service).
 * Resolver order: exact canonical → ILIKE contains (project-local semantic) →
 * ambiguity surfaced as multiple candidates (never silent low-confidence
 * binding). Entity sources are the production tables (project_characters /
 * project_references); the returned binding is a STRUCTURED entity reference
 * (ReferenceBinding), never name-mangled into a prompt.
 */
/**
 * Mirrors src/features/studio-v2/composerModel.ts parseRefTokens (server-side
 * twin, zero deps). Bracket form @[Name #2] and bare tokens; returns ranges.
 */
function parseRefTokens(text) {
  const hits = [];
  const re = /@(?:\[([^\]]+)\]|([^\s@,.!?;:"'()[\]]+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    hits.push({ token: raw, range: { start: m.index, end: m.index + raw.length + 1 } });
  }
  return hits;
}

async function resolveCandidates(pg, { projectId, query }) {
  const needle = `%${query}%`;
  const rows = [];
  // characters: exact then contains
  const ch = await pg.query(
    `SELECT id, name FROM project_characters
     WHERE project_id = $1 AND (name = $2 OR name ILIKE $3)
     ORDER BY (name = $2) DESC, name ASC LIMIT 8`,
    [projectId, query, needle],
  );
  for (const r of ch.rows) rows.push({ entityType: 'character', entityId: r.id, canonicalName: r.name });
  const rf = await pg.query(
    `SELECT id, name, type FROM project_references
     WHERE project_id = $1 AND (name = $2 OR name ILIKE $3)
     ORDER BY (name = $2) DESC, name ASC LIMIT 8`,
    [projectId, query, needle],
  );
  for (const r of rf.rows) {
    rows.push({ entityType: mapType(r.type), entityId: r.id, canonicalName: r.name, kind: r.type });
  }
  return rows;
}

function mapType(t) {
  const low = String(t || '').toLowerCase();
  if (low.startsWith('character')) return 'character';
  if (low.startsWith('environment') || low.startsWith('scene')) return 'location';
  if (low.startsWith('prop')) return 'prop';
  if (low.startsWith('style')) return 'style';
  return 'asset';
}

/**
 * Resolve one @token within a project.
 * Exact single → { resolution: 'exact', binding }
 * Contains single → { resolution: 'semantic', binding, confidence: 0.6 }
 * Multiple → { resolution: 'ambiguous', candidates } — caller must confirm.
 * None → { resolution: 'none' } — never silently bound.
 */
async function resolveToken(pg, { projectId, token }) {
  const rows = await resolveCandidates(pg, { projectId, query: token });
  if (rows.length === 0) return { resolution: 'none', token };
  const exact = rows.filter((r) => r.canonicalName === token);
  if (exact.length === 1) return { resolution: 'exact', token, binding: bindingOf(exact[0], 'autolink') };
  if (rows.length === 1) return { resolution: 'semantic', token, binding: bindingOf(rows[0], 'autolink'), confidence: 0.6 };
  return { resolution: 'ambiguous', token, candidates: rows.map((r) => bindingOf(r, 'autolink')) };
}

function bindingOf(c, source) {
  const b = {
    token: c.canonicalName,
    entityType: c.entityType,
    entityId: c.entityId,
    source,
  };
  if (c.kind) b.kind = c.kind;
  return b;
}

/** Resolve every @token in a prompt (G07 composer integration point). */
async function resolvePromptTokens(pg, { projectId, text }) {
  const tokens = parseRefTokens(text);
  const out = [];
  for (const t of tokens) {
    const r = await resolveToken(pg, { projectId, token: t.token });
    out.push({ token: t.token, range: t.range, ...r });
  }
  return out;
}

module.exports = { resolveToken, resolvePromptTokens, resolveCandidates, mapType };
