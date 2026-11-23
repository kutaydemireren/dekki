// "Next prompt" in History: one definition shared by the button's visibility and its click, so the button never
// does nothing. Pure logic, no DOM.

export const NEXT_SLACK = 8; // a prompt this close to (or above) the top edge is "the current one", not the next

/**
 * Scroll position the next prompt would land at, or null when there is none worth jumping to.
 * `tops` = offsetTop of each prompt in document order; the view can never scroll past `maxScroll`
 * (scrollHeight - clientHeight), so a prompt that cannot move closer than NEXT_SLACK below the current position
 * (e.g. the last prompt when the view is at the bottom) is not a next prompt. Later prompts clamp to the same
 * limit, so looking at the first prompt below the top edge is enough.
 */
export function nextPromptTarget(tops, scrollTop, maxScroll) {
  const next = tops.find((t) => t > scrollTop + NEXT_SLACK);
  if (next === undefined) return null;
  const target = Math.min(next, Math.max(0, maxScroll));
  return target > scrollTop + NEXT_SLACK ? target : null;
}
