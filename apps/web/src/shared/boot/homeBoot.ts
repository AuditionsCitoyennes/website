// The home page's first render: the HTML's inline script (homeBootPlan.ts)
// puts the theme's class on <html> and, on "/", the shell's dark ground under
// the still empty page; the home page takes the shell off once it is in.

import { HOME_SHELL_CLASS } from "./homeBootPlan";

/** The home page is in: the shell's ground is no longer wanted (a later
 *  page waiting for its code is never painted in the hero's ground). */
export function endHomeShell() {
  document.documentElement.classList.remove(HOME_SHELL_CLASS);
}
