// Pure parts of the motion layer (see motion.js). No DOM here, so they are unit-tested.

/** FLIP: which elements moved vertically between two layouts. prev / next: Map id -> top (px, relative to the scroll content).
 *  Returns { moved: [{id, dy}] (dy = old top - new top: the starting offset), entered: [id] (new ids) }.
 *  Moves under `min` px are ignored; with more than `max` movers (a search, a big reshuffle) nothing glides. */
export function flipPlan(prev, next, { min = 2, max = 40 } = {}) {
  const moved = [];
  const entered = [];
  for (const [id, top] of next) {
    if (!prev.has(id)) { entered.push(id); continue; }
    const dy = prev.get(id) - top;
    if (Math.abs(dy) >= min) moved.push({ id, dy });
  }
  if (moved.length > max) return { moved: [], entered: [] };
  return { moved, entered };
}

/** Flash kind for a row whose status glyph changed: 'needs' (the agent now needs you), 'done' (it finished), or null.
 *  A first sighting (prev undefined), a working -> working repeat or a move into stopped / failed does not flash. */
export function flashKind(prev, next) {
  if (!prev || prev === next) return null;
  if (next === 'needs') return 'needs';
  if (next === 'done' && prev === 'working') return 'done';
  return null;
}
