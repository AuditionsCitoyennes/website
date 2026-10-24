import type { FastifyInstance } from "fastify";
import { renderTile, SelectionTooLarge, setSelection } from "./service";

// The largest selection the site sends (a département's union of communes)
// is ~150 KB of JSON; the server-wide 1 MB would let anyone POST seven of
// them in one body.
const SELECTION_BODY_LIMIT = 512 * 1024;

// Custom DEM tiles for the "Plateau" elevation mode: the client POSTs the selected
// polygons + a height, gets back a version key, then points a raster-dem source at
// /:version/{z}/{x}/{y}. Tiles raise the selection as a flat-topped plateau.
export default async function demRoutes(app: FastifyInstance) {
  app.post<{ Body: { features?: unknown[]; height?: number } }>(
    "/",
    { bodyLimit: SELECTION_BODY_LIMIT },
    async (req, reply) => {
      const features = (req.body?.features ?? []) as Parameters<typeof setSelection>[0];
      const height = Number(req.body?.height) || 4000;
      try {
        return { version: setSelection(features, height) };
      } catch (e) {
        if (e instanceof SelectionTooLarge) return reply.badRequest(e.message);
        throw e;
      }
    },
  );

  app.get<{ Params: { version: string; z: string; x: string; y: string } }>(
    "/:version/:z/:x/:y",
    async (req, reply) => {
      const { version, z, x, y } = req.params;
      const tile = renderTile(version, Number(z), Number(x), Number.parseInt(y, 10));
      if (!tile) return reply.notFound("unknown DEM version");
      // A tile is a pure function of its URL (the version key hashes the
      // selection, the height and RENDER_REV), so a client may keep it a year
      // without asking: drilling the same territory again fetches nothing.
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(tile);
    },
  );
}
