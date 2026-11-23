// One 14px shape per state, so status reads without colour. CSS: styles/glyph.css.
import './styles/glyph.css';

const STATES = ['working', 'needs', 'done', 'failed', 'stalled', 'stopped'];

// active={false} is the one rule for "nothing of this kind exists" (a count of 0): same shape, dimmed, never animated.
export default function StatusGlyph({ state, active = true }) {
  const s = STATES.includes(state) ? state : 'stopped';
  return <span className={`g g-${s}${active ? '' : ' idle'}`} aria-hidden="true" />;
}
export { StatusGlyph };
