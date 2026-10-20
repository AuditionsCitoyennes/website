import type { FastifyInstance } from "fastify";
import { renderTile, setSelection } from "./service";

// Custom DEM tiles for the "Plateau" elevation mode: the client POSTs the selected
// polygons + a height, gets back a version key, then points a raster-dem source at
// /:version/{z}/{x}/{y}. Tiles raise the selection as a flat-topped plateau.
export default async function demRoutes(app: FastifyInstance) {
  app.post<{ Body: { features?: unknown[]; height?: number } }>("/", async (req) => {
    const features = (req.body?.features ?? []) as Parameters<typeof setSelection>[0];
    const height = Number(req.body?.height) || 4000;
    return { version: setSelection(features, height) };
  });

  app.get<{ Params: { version: string; z: string; x: string; y: string } }>(
    "/:version/:z/:x/:y",
    async (req, reply) => {
      const { version, z, x, y } = req.params;
      const tile = renderTile(version, Number(z), Number(x), Number.parseInt(y, 10));
      if (!tile) return reply.notFound("unknown DEM version");
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=3600")
        .send(tile);
    },
  );
}
