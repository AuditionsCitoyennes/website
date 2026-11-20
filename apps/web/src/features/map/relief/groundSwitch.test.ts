// The plateau's ground (groundSwitch.ts), run with `node --import tsx --test`
// (root "test:scripts"): the ground each device tier gives; the renderer's
// name read from a context.

import assert from "node:assert/strict";
import { test } from "node:test";
import { groundFor, rendererOf } from "./groundSwitch";

test("groundFor: relief on the full tier, flat on a weak device", () => {
  assert.equal(groundFor("full"), "relief");
  assert.equal(groundFor("light"), "flat");
  assert.equal(groundFor("minimal"), "flat");
});

test("rendererOf: the unmasked name, else the plain one, else null", () => {
  const RENDERER = 0x1f01;
  const UNMASKED = 0x9246;
  const gl = (ext: boolean, names: Record<number, unknown>) =>
    ({
      RENDERER,
      getExtension: (name: string) =>
        ext && name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: UNMASKED } : null,
      getParameter: (p: number) => names[p],
    }) as unknown as WebGLRenderingContext;
  assert.equal(
    rendererOf(gl(true, { [UNMASKED]: "ANGLE (Google, SwiftShader)", [RENDERER]: "WebKit WebGL" })),
    "ANGLE (Google, SwiftShader)",
  );
  assert.equal(rendererOf(gl(false, { [RENDERER]: "Apple GPU" })), "Apple GPU");
  assert.equal(rendererOf(gl(true, { [UNMASKED]: "" })), null);
  assert.equal(rendererOf(gl(false, {})), null);
  assert.equal(rendererOf(null), null);
  const lost = {
    RENDERER,
    getExtension: () => {
      throw new Error("context lost");
    },
    getParameter: () => null,
  } as unknown as WebGLRenderingContext;
  assert.equal(rendererOf(lost), null);
});
