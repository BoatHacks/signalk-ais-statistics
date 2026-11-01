// Download links for the exports (SPEC 6.1 and 7): plain links to the
// plugin's export routes, so the browser saves the file with the session
// cookie and the name the server gives it. The URLs come from exportHref
// in api.ts.
import { el } from './format'

/** A download link styled as a button; without an href it is greyed out. */
export function downloadLink(label: string): HTMLAnchorElement {
  return el('a', { class: 'download', download: '' }, label)
}

/** Points a link at a file, or disables it with the reason as its title. */
export function setLink(
  a: HTMLAnchorElement,
  href: string | undefined,
  disabledTitle = '',
): void {
  if (href) {
    a.href = href
    a.removeAttribute('aria-disabled')
    a.removeAttribute('title')
  } else {
    a.removeAttribute('href')
    a.setAttribute('aria-disabled', 'true')
    a.title = disabledTitle
  }
}
