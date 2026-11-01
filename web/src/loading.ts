// Loading status on the control that started a load: the control fades in
// and out while the data loads (chosen by the maintainer). Loads that end
// within the delay do not blink, so quick answers do not flicker.

/** Loads shorter than this show no loading status. */
export const LOADING_DELAY_MS = 200

/** What showLoading needs of an element, so it runs without a DOM. */
export interface ClassTarget {
  classList: { add(name: string): void; remove(name: string): void }
}

/**
 * Marks `target` with the `loading` class while `work` runs, after the
 * delay. Returns a function that ends the status early, for when a later
 * load takes over.
 */
export function showLoading(
  target: ClassTarget,
  work: Promise<unknown>,
  delay = LOADING_DELAY_MS,
): () => void {
  const timer = setTimeout(() => target.classList.add('loading'), delay)
  const stop = () => {
    clearTimeout(timer)
    target.classList.remove('loading')
  }
  work.then(stop, stop)
  return stop
}
