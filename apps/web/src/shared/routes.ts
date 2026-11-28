// The routes by name and path, as the router declares them (app/router/routes.ts)
// and as the pages and the header refer to them. No imports: the features read
// this, never app/.
//
// An identifier in a path is letters, digits, `_` and `-` (the ids and the
// verification tokens are UUIDs): the pages write it into the API paths they
// call, so an address whose identifier holds anything else matches no page.

export const ROUTE = {
  home: { name: "home", path: "/" },
  temoignages: { name: "temoignages", path: "/temoignages" },
  auditionDetail: { name: "audition-detail", path: "/audition/:id([\\w-]+)" },
  auth: { name: "auth", path: "/auth" },
  admin: { name: "admin", path: "/admin" },
  secondFactor: { name: "second-factor", path: "/admin/double-authentification" },
  verifyTestimony: { name: "verify-testimony", path: "/verifier/:token([\\w-]+)" },
  resetPassword: { name: "reset-password", path: "/reset-password" },
  support: { name: "support", path: "/soutenir" },
  legalNotice: { name: "legal-notice", path: "/mentions-legales" },
  privacy: { name: "privacy", path: "/confidentialite" },
  rules: { name: "rules", path: "/regles" },
  notFound: { name: "not-found", path: "/:pathMatch(.*)*" },
} as const;
