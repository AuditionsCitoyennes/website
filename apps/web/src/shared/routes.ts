// The routes by name and path, as the router declares them (app/router/routes.ts)
// and as the pages and the header refer to them. No imports: the features read
// this, never app/.

export const ROUTE = {
  home: { name: "home", path: "/" },
  temoignages: { name: "temoignages", path: "/temoignages" },
  auditionDetail: { name: "audition-detail", path: "/audition/:id" },
  auth: { name: "auth", path: "/auth" },
  admin: { name: "admin", path: "/admin" },
  verifyTestimony: { name: "verify-testimony", path: "/verifier/:token" },
  resetPassword: { name: "reset-password", path: "/reset-password" },
  notFound: { name: "not-found", path: "/:pathMatch(.*)*" },
} as const;
