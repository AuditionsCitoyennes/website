// The panel's lines from the server's lists (map phase 1, PR K): a lieu's
// list, sent newest first, re-sorted by the panel as the corpus' is, comes out
// in lieu_auditions' order for either sort (date, then id) — so one read
// serves both; and a server row's line. Run with `node --import tsx --test`
// (root "test:scripts"). Pure: no Vue, no alias at run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bySort, serverPanelAudition } from "./auditions";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** As place_counts embeds a lieu's list, and lieu_auditions sends it for
 *  "recent": date desc, then id. */
const LIST = [
  { id: id(4), title: "D", date: "2026-10-01", n: 2 },
  { id: id(2), title: "B", date: "2026-09-01", n: 1 },
  { id: id(3), title: "C", date: "2026-09-01", n: 5 },
  { id: id(1), title: "A", date: "2026-05-01", n: 3 },
];

/** lieu_auditions' order: date in the sort's direction, then id. */
function lieuOrder(sort: "recent" | "ancien") {
  return [...LIST].sort((a, b) =>
    a.date !== b.date
      ? (a.date < b.date ? -1 : 1) * (sort === "ancien" ? 1 : -1)
      : a.id < b.id
        ? -1
        : 1,
  );
}

test("a lieu's list re-sorted by the panel is lieu_auditions' order, either sort", () => {
  for (const sort of ["recent", "ancien"] as const) {
    const panel = [...LIST].sort((a, b) => bySort(a, b, sort));
    assert.deepEqual(
      panel.map((a) => a.id),
      lieuOrder(sort).map((a) => a.id),
      sort,
    );
  }
});

test("a server row's line: its lieu by id, its count, its testimonies once here", () => {
  const lieu = {
    id: "l:0123456789abcdef",
    key: "Place Bellecour, Lyon",
    unit: "fr:com:69382",
    path: ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69382"],
    lat: 45.757,
    lng: 4.832,
    city: "Lyon",
  };
  const loading = serverPanelAudition(
    LIST[0],
    { id: lieu.id, canonical: lieu.key, lieu },
    { list: null, more: false, failed: false },
  );
  assert.deepEqual(loading, {
    id: LIST[0].id,
    title: "D",
    date: "2026-10-01",
    canonical: lieu.key,
    placeId: lieu.id,
    count: 2,
    testimonies: null,
    lieu,
  });
  const here = serverPanelAudition(
    LIST[0],
    { id: lieu.id, canonical: lieu.key },
    { list: [], more: true, failed: false },
  );
  assert.deepEqual(here.testimonies, []);
  assert.equal(here.more, true);
  assert.equal("lieu" in here, false);
  const failed = serverPanelAudition(
    LIST[0],
    { id: lieu.id, canonical: lieu.key },
    { list: [], more: false, failed: true },
  );
  assert.equal(failed.failed, true);
});
