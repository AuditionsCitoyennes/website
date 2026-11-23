// Whether the site's footer is on show under the page (App.vue). Not under the
// map page, which the map fills. Not before the first page is known either:
// until the router's first navigation settles (a lazily loaded page's code
// still coming), the route is vue-router's START_LOCATION, which matches no
// route — the footer would stand at the foot of an empty page, then jump away
// or below the fold once the page comes in. Every resolved route matches at
// least one record, the « page introuvable » catch-all included.
//
// Pure: loadable under node (footerShown.test.ts).
import { ROUTE } from "../shared/routes";

export function footerShown(route: { matched: readonly unknown[]; path: string }): boolean {
  return route.matched.length > 0 && route.path !== ROUTE.temoignages.path;
}
