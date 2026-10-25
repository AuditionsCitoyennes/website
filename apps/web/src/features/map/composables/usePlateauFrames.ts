// The frame bus: where the plateau and its slabs stand on screen, every frame
// drawn, for what is laid over the map and must move with it. Per frame nothing
// allocates and nothing touches Vue state (see emitFrame).

import type mapboxgl from "mapbox-gl";
import { perfEnd, perfOn, perfPending } from "@/shared/perf/perf";
import type { PlateauFrame, SlabFrame } from "../types";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import { WALL_OVERSHOOT } from "../gl/mesh";
import { STRIDE } from "../lib/projection";
import type { Insets } from "./useMapView";

export interface PlateauFramesInputs {
  getMap: () => mapboxgl.Map | null;
  /** The plateau's layer: the camera each frame was drawn with, the rim, the slabs. */
  wall: PlateauWallLayer;
}

export function usePlateauFrames({ getMap, wall: plateauWall }: PlateauFramesInputs) {
  // ---- Frame bus: where the plateau stands on screen, every frame drawn ---------
  // For what is laid over the map and must move WITH the plateau (the analyses
  // plates, their leader lines, labels on the lid). mapbox fires `render` at the
  // end of every frame it draws, in the same task as the draw: camera moves, the
  // rise and sink (camera still — `move` misses those), resizes (drawNow) and the
  // halo's paced repaints. The plateau layer keeps the camera each frame was
  // drawn with, and the rim is projected with it — never with map.project (see
  // projectInto). Per frame nothing allocates and nothing touches Vue state, and
  // a frame that would come out identical to the last one is not sent at all:
  // that is the halo's 25 Hz while the map stands still.
  interface FrameBuf {
    frame: PlateauFrame;
    okTop: Uint8Array;
    okBase: Uint8Array;
    box: { minX: number; minY: number; maxX: number; maxY: number };
    /** The boxes of words' frames, handed out (or not) as frame.slabs.ring,
     *  .label, .plaque. */
    slabRing: SlabFrame;
    slabLabel: SlabFrame;
    slabPlaque: SlabFrame;
    slabOk: Uint8Array;
  }
  const makeSlabFrame = (): SlabFrame => ({ w: 0, h: 0, lid: new Float32Array(8), ok: false });
  function makeFrameBuf(): FrameBuf {
    return {
      frame: {
        scopeId: "",
        rise: 0,
        w: 0,
        h: 0,
        pitch: 0,
        bearing: 0,
        zoom: 0,
        centre: [0, 0],
        n: 0,
        top: new Float32Array(0),
        base: new Float32Array(0),
        ok: new Uint8Array(0),
        box: null,
        slabs: { scopeId: "", rise: 0, version: 0, ring: null, label: null, plaque: null },
      },
      okTop: new Uint8Array(0),
      okBase: new Uint8Array(0),
      box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      slabRing: makeSlabFrame(),
      slabLabel: makeSlabFrame(),
      slabPlaque: makeSlabFrame(),
      slabOk: new Uint8Array(4),
    };
  }

  /** The boxes of words on screen (see PlateauSlabs), at their lids' height,
   *  at their rise this frame. */
  function fillSlabs(buf: FrameBuf, camValid: boolean, w: number, h: number) {
    const layer = plateauWall;
    const s = buf.frame.slabs;
    s.scopeId = layer.slabScopeId;
    s.rise = layer.slabRise;
    s.version = layer.slabVersion;
    s.ring = null;
    s.label = null;
    s.plaque = null;
    const alt = layer.slabHeightM * WALL_OVERSHOOT * layer.slabRise;
    for (let i = 0; i < layer.slabQuads.length; i++) {
      const q = layer.slabQuads[i];
      const out =
        q.name === "ring"
          ? buf.slabRing
          : q.name === "label"
            ? buf.slabLabel
            : q.name === "plaque"
              ? buf.slabPlaque
              : null;
      if (!out) continue; // the bar: no words
      out.w = q.w;
      out.h = q.h;
      out.ok = false;
      if (camValid) {
        layer.projectInto(layer.slabCorners, 4, alt, w, h, out.lid, buf.slabOk, q.at);
        out.ok = (buf.slabOk[0] & buf.slabOk[1] & buf.slabOk[2] & buf.slabOk[3]) === 1;
      }
      if (q.name === "ring") s.ring = out;
      else if (q.name === "label") s.label = out;
      else s.plaque = out;
    }
  }
  const frameBuf = makeFrameBuf();
  /** Subscribers; replaced (never mutated) on change, so a callback that
   *  unsubscribes mid-delivery cannot disturb the loop delivering to it. */
  let frameSubs: { cb: (f: PlateauFrame) => void; live: boolean }[] = [];
  /** Send the next frame even if it matches the last (a new subscriber). */
  let frameForce = true;
  /** The plateau layer's capture count at the last `render` (see emitFrame). */
  let seenCamSeq = 0;
  /** Whether the last `render` was drawn with a camera the layer captured. */
  let camFresh = false;
  // The container's CSS size: mapbox's transform has what its matrices were built
  // for (CSS transforms on ancestors already divided out); the ResizeObserver's
  // last numbers stand in should those internals ever move.
  let roW = 0;
  let roH = 0;
  let frameW = 0;
  let frameH = 0;
  // The last frame sent, as numbers: camera, rise, rim, size, padding.
  const frameSig = new Float64Array(64).fill(NaN);
  let sigAt = 0;
  let sigDiff = false;
  function sigPut(v: number) {
    if (frameSig[sigAt] !== v) {
      frameSig[sigAt] = v;
      sigDiff = true;
    }
    sigAt++;
  }
  // DEV probe counters (plain numbers).
  let framesSent = 0;
  let framesSkipped = 0;

  function readFrameSize() {
    const map = getMap();
    const tr = (map as unknown as { transform?: { width?: unknown; height?: unknown } } | null)
      ?.transform;
    const w = tr?.width;
    const h = tr?.height;
    if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
      frameW = w;
      frameH = h;
    } else {
      frameW = roW;
      frameH = roH;
    }
  }

  /** The camera's padding, without the copy getPadding() allocates. */
  function cameraInsets(): Insets | null {
    const map = getMap();
    const ei = (map as unknown as { transform?: { _edgeInsets?: Insets } } | null)?.transform
      ?._edgeInsets;
    if (ei && typeof ei.top === "number" && typeof ei.left === "number") return ei;
    return map ? (map.getPadding() as Insets) : null;
  }

  /** Fill a frame from the last captured camera (`camValid` false: no camera). */
  function fillFrame(buf: FrameBuf, camValid: boolean, pad: Insets | null) {
    const map = getMap();
    const f = buf.frame;
    const layer = plateauWall;
    const n = layer.rimCount;
    // Sized to the rim: reallocated only when the rim changes length.
    if (f.ok.length !== n) {
      f.top = new Float32Array(2 * n);
      f.base = new Float32Array(2 * n);
      f.ok = new Uint8Array(n);
      buf.okTop = new Uint8Array(n);
      buf.okBase = new Uint8Array(n);
    }
    const w = frameW;
    const h = frameH;
    f.scopeId = layer.scopeId;
    f.rise = layer.rise;
    f.w = w;
    f.h = h;
    f.pitch = map ? map.getPitch() : 0;
    f.bearing = map ? map.getBearing() : 0;
    f.zoom = map ? map.getZoom() : 0;
    // mapbox's own padded centre (EdgeInsets.getCenter), clamped to the view.
    const pl = pad?.left ?? 0;
    const pr = pad?.right ?? 0;
    const pt = pad?.top ?? 0;
    const pb = pad?.bottom ?? 0;
    f.centre[0] = Math.min(w, Math.max(0, (pl + w - pr) / 2));
    f.centre[1] = Math.min(h, Math.max(0, (pt + h - pb) / 2));
    f.n = n;
    f.box = null;
    fillSlabs(buf, camValid, w, h);
    if (!camValid || !n) {
      f.ok.fill(0);
      return;
    }
    const rise = layer.rise;
    layer.projectInto(layer.rim, n, layer.heightM * WALL_OVERSHOOT * rise, w, h, f.top, buf.okTop);
    layer.projectInto(layer.rim, n, 0, w, h, f.base, buf.okBase);
    let any = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = buf.okTop[i] & buf.okBase[i];
      f.ok[i] = v;
      if (!v) continue;
      any = true;
      const tx = f.top[2 * i];
      const ty = f.top[2 * i + 1];
      const bx = f.base[2 * i];
      const by = f.base[2 * i + 1];
      minX = Math.min(minX, tx, bx);
      maxX = Math.max(maxX, tx, bx);
      minY = Math.min(minY, ty, by);
      maxY = Math.max(maxY, ty, by);
    }
    if (any && rise >= 0.02) {
      const b = buf.box;
      b.minX = minX;
      b.minY = minY;
      b.maxX = maxX;
      b.maxY = maxY;
      f.box = b;
    }
  }

  /** The `render` listener: send this frame's plateau to every subscriber. */
  function emitFrame() {
    const cam = plateauWall.cam;
    // The plateau layer is drawn in every frame mapbox renders once the style is
    // up; a frame it was NOT drawn in (style loading or being replaced) has no
    // camera of its own to project with — the plateau isn't on screen either.
    camFresh = cam.seq !== seenCamSeq;
    seenCamSeq = cam.seq;
    // The perf probes: the plateau drawn at full rise ends "select → plateau".
    if (perfOn) {
      const pending = perfPending("select-plateau");
      if (pending && camFresh && plateauWall.rise >= 0.999 && plateauWall.scopeId === pending) {
        perfEnd("select-plateau", pending, { rise: Math.round(plateauWall.rise * 1000) / 1000 });
      }
    }
    const subs = frameSubs;
    const map = getMap();
    if (!subs.length || !map) return;
    readFrameSize();
    const pad = cameraInsets();
    sigAt = 0;
    sigDiff = frameForce;
    frameForce = false;
    sigPut(camFresh ? 1 : 0);
    for (let i = 0; i < 16; i++) sigPut(cam.m[i]);
    sigPut(cam.globe ? 1 : 0);
    if (cam.globe) {
      for (let i = 0; i < 16; i++) sigPut(cam.g2m[i]);
      sigPut(cam.t);
      sigPut(cam.cx);
      sigPut(cam.cy);
      sigPut(cam.r);
    }
    sigPut(plateauWall.rise);
    sigPut(plateauWall.rimVersion);
    sigPut(plateauWall.slabVersion);
    sigPut(plateauWall.slabPresence);
    sigPut(frameW);
    sigPut(frameH);
    if (pad) {
      sigPut(pad.top);
      sigPut(pad.bottom);
      sigPut(pad.left);
      sigPut(pad.right);
    }
    if (!sigDiff) {
      framesSkipped++;
      return;
    }
    fillFrame(frameBuf, camFresh, pad);
    framesSent++;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      if (!s.live) continue;
      // Inside mapbox's frame: a throwing subscriber must not abort the rest of it.
      try {
        s.cb(frameBuf.frame);
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[plateau] frame subscriber failed:", err);
      }
    }
  }

  /** Subscribe to the plateau's frames; the first arrives with the next render. */
  function onFrame(cb: (f: PlateauFrame) => void): () => void {
    const sub = { cb, live: true };
    frameSubs = [...frameSubs, sub];
    frameForce = true; // even if nothing has moved since the last frame sent
    getMap()?.triggerRepaint();
    return () => {
      if (!sub.live) return;
      sub.live = false;
      frameSubs = frameSubs.filter((s) => s !== sub);
    };
  }

  /** DEV probe (window.__acFrame): a copy of the frame as it stands now, and a
   *  cross-check against mapbox's own projection on the rim. In mercator
   *  map.project adds the terrain sampled under the point, which the eroded DEM
   *  keeps at ~0 on the rim itself — so there `base` should match map.project(ll)
   *  and `top` map.project(ll, lidAltM) to within a pixel or so. On the globe
   *  map.project adds the centre's altitude instead: expect a drift there. */
  function probeFrame() {
    const map = getMap();
    if (!map) return null;
    const buf = makeFrameBuf();
    readFrameSize();
    fillFrame(buf, plateauWall.cam.seq > 0 && camFresh, cameraInsets());
    const f = buf.frame;
    const lidAltM = plateauWall.heightM * WALL_OVERSHOOT * plateauWall.rise;
    let checked = 0;
    let baseMax = 0;
    let topMax = 0;
    let baseSum = 0;
    let topSum = 0;
    for (let i = 0; i < f.n; i++) {
      if (!f.ok[i]) continue;
      const o = i * STRIDE;
      const ll: [number, number] = [plateauWall.rim[o + 9], plateauWall.rim[o + 10]];
      const pb = map.project(ll);
      const pt = map.project(ll, lidAltM);
      if (Math.abs(pb.x) > 1e6 || Math.abs(pt.x) > 1e6) continue;
      const db = Math.hypot(pb.x - f.base[2 * i], pb.y - f.base[2 * i + 1]);
      const dt = Math.hypot(pt.x - f.top[2 * i], pt.y - f.top[2 * i + 1]);
      checked++;
      baseSum += db;
      topSum += dt;
      baseMax = Math.max(baseMax, db);
      topMax = Math.max(topMax, dt);
    }
    const cam = plateauWall.cam;
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      scopeId: f.scopeId,
      rise: round(f.rise),
      heightM: round(plateauWall.heightM),
      lidAltM: round(lidAltM),
      w: f.w,
      h: f.h,
      pitch: round(f.pitch),
      bearing: round(f.bearing),
      zoom: round(f.zoom),
      centre: [round(f.centre[0]), round(f.centre[1])],
      regime: cam.globe ? `globe(t=${cam.t.toFixed(2)})` : "mercator",
      n: f.n,
      valid: f.ok.reduce((a, v) => a + v, 0),
      box: f.box && {
        minX: round(f.box.minX),
        minY: round(f.box.minY),
        maxX: round(f.box.maxX),
        maxY: round(f.box.maxY),
      },
      top: Array.from(f.top, round),
      base: Array.from(f.base, round),
      ok: Array.from(f.ok),
      slabs: {
        scopeId: f.slabs.scopeId,
        rise: round(f.slabs.rise),
        version: f.slabs.version,
        ...Object.fromEntries(
          (["ring", "label", "plaque"] as const).map((k) => {
            const b = f.slabs[k];
            return [k, b && { w: b.w, h: b.h, ok: b.ok, lid: Array.from(b.lid, round) }];
          }),
        ),
      },
      subscribers: frameSubs.length,
      framesSent,
      framesSkipped,
      vsMapProject: {
        checked,
        baseMeanPx: checked ? round(baseSum / checked) : null,
        baseMaxPx: round(baseMax),
        topMeanPx: checked ? round(topSum / checked) : null,
        topMaxPx: round(topMax),
      },
    };
  }

  /** The container's CSS size, from the component's ResizeObserver: what stands
   *  in for mapbox's transform size should its internals ever move. */
  function setContainerSize(w: number, h: number) {
    roW = w;
    roH = h;
  }

  /** Unmount: no subscriber is called again. */
  function dispose() {
    for (const s of frameSubs) s.live = false;
    frameSubs = [];
  }

  return {
    /** The `render` listener. */
    emitFrame,
    onFrame,
    setContainerSize,
    /** The frame size read from mapbox's transform (frameW/frameH after it). */
    readFrameSize,
    frameW: () => frameW,
    frameH: () => frameH,
    /** Whether the last `render` was drawn with a camera the layer captured. */
    camFresh: () => camFresh,
    /** DEV probe (window.__acFrame). */
    probe: probeFrame,
    dispose,
  };
}
