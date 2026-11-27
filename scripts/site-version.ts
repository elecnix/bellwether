// The byline that each documentation page opens with, written by
// scripts/build-site.ts and read back by scripts/release.ts, so the two agree
// on one format.

export const SITE_NAME = 'Bellwether';

/** Where the pages workflow publishes the site. */
export const SITE_URL = 'https://elecnix.github.io/bellwether/';

/** The opening of a page's byline, up to the version it names. */
export function bylineOpening(version: string): string {
  return `<p class="byline">${SITE_NAME} ${version} · `;
}

/** The version a page's byline names, or undefined when the page has no byline. */
export function bylineVersion(html: string): string | undefined {
  return new RegExp(`<p class="byline">${SITE_NAME} (\\d+\\.\\d+\\.\\d+\\S*) · `).exec(html)?.[1];
}
