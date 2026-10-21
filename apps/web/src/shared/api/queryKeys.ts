// vue-query keys of the public data the whole site shares: the Témoignages
// page queries them, and app/AppDialogs.vue invalidates them when an audition
// is created from anywhere.
export const TESTIMONIES_KEY = ["testimonies"] as const;
export const MAP_KEY = ["map"] as const;
