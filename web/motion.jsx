import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { flipPlan, flashKind } from './motion-logic.js';

// Small motion layer. All of it is under 200ms, off for prefers-reduced-motion, and never blocks input
// (animations are transforms / opacity on elements that are already laid out). CSS pieces live in styles/motion.css.
const MS = 180;
const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const canAnimate = (el) => typeof el.animate === 'function';

/** Rows (and group heads) glide to their new position when the list reshuffles, rows that appear fade in, and a row whose
 *  agent finished or now needs you flashes. Put data-flip-id on every glidable element and data-gs (glyph state) on rows.
 *  The list must be position: relative (motion.css) so offsetTop is measured against it. */
export function useListMotion(listRef) {
  const prev = useRef(null); // Map id -> top
  const states = useRef(new Map()); // id -> last glyph state
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const els = [...list.querySelectorAll('[data-flip-id]')];
    // position inside the scroll content from offsetTop (transforms, i.e. a glide in progress, do not count; scrolling does not either)
    const topOf = (el) => { let y = 0; for (let n = el; n && n !== list; n = n.offsetParent) y += n.offsetTop; return y; };
    const next = new Map(els.map((el) => [el.dataset.flipId, topOf(el)]));
    const old = prev.current;
    prev.current = next;
    const nextStates = new Map();
    const flashes = [];
    for (const el of els) {
      const gs = el.dataset.gs;
      if (!gs) continue;
      nextStates.set(el.dataset.flipId, gs);
      const kind = old && flashKind(states.current.get(el.dataset.flipId), gs);
      if (kind) flashes.push([el, kind]);
    }
    states.current = nextStates;
    if (!old || reduced()) return;
    const byId = new Map(els.map((el) => [el.dataset.flipId, el]));
    const { moved, entered } = flipPlan(old, next);
    for (const { id, dy } of moved) {
      const el = byId.get(id);
      if (el && canAnimate(el)) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MS, easing: 'ease-out', id: 'flip' });
    }
    for (const id of entered) {
      const el = byId.get(id);
      if (el && canAnimate(el)) el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: MS, easing: 'ease-out', id: 'flip' });
    }
    for (const [el, kind] of flashes) {
      // A data attribute, not a class: React rewrites className on the next render (e.g. unread clearing) and would cut the flash short.
      el.removeAttribute('data-flash');
      void el.offsetWidth; // restart the CSS animation if it is still running
      el.setAttribute('data-flash', kind);
      el.addEventListener('animationend', function done(e) { if (e.target !== el) return; el.removeEventListener('animationend', done); el.removeAttribute('data-flash'); });
    }
  });
}

/** A number that ticks (small slide + fade) when its value changes; the first render stays still. */
export function Tick({ value, className = '' }) {
  const seen = useRef(false);
  useEffect(() => { seen.current = true; }, []);
  return <span key={value} className={`${className}${seen.current ? ' tick' : ''}`.trim()}>{value}</span>;
}

/** Fade the main pane in when the view changes (another agent or tab). Animates .tab-body in place: no remount. */
export function useViewFade(key) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (reduced()) return;
    const el = document.querySelector('.main .tab-body');
    if (el && canAnimate(el)) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MS, easing: 'ease-out' });
  }, [key]);
}
