// The lid's GL limits and its texture upload, out of PlateauWallLayer: the
// reads happen once when the layer is added (readLidGlLimits, from onAdd), the
// upload in the frame a fresh snapshot lands in (uploadLidTexture, from
// render). No GL query in the upload on purpose: a query waits for the GPU
// process's backlog, and the upload runs in the frame the lid lands in (#171:
// getParameter(MAX_TEXTURE_MAX_ANISOTROPY_EXT) 2,883 ms there under
// SwiftShader). Pure: no mapbox, no DOM global.

export interface LidGlLimits {
  /** GL_MAX_TEXTURE_SIZE: caps the lid snapshot's pixel budget. */
  maxTextureSize: number;
  anisoExt: EXT_texture_filter_anisotropic | null;
  /** -1 = extension unavailable (0 is the layer's "not read yet", before onAdd). */
  maxAniso: number;
}

/** The context's limits the lid needs, read on every add (one query each). */
export function readLidGlLimits(gl: WebGL2RenderingContext): LidGlLimits {
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const anisoExt = gl.getExtension("EXT_texture_filter_anisotropic");
  const maxAniso = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : -1;
  return { maxTextureSize, anisoExt, maxAniso };
}

/** Upload a landed snapshot into `tex` (bitmap → texture), with the lid's
 *  filtering: state, upload and mipmap calls only, no query. */
export function uploadLidTexture(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture | null,
  bitmap: ImageBitmap,
  anisoExt: EXT_texture_filter_anisotropic | null,
  maxAniso: number,
): void {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // row 0 = north = min mercator y
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  // The lid is a texture on a plane the camera looks ALONG at ELEV_PITCH, so
  // its far half is minified and its near half magnified. A plain LINEAR
  // min-filter takes a single bilinear tap per fragment, which drops detail
  // and shimmers across the far half — while the live basemap beside it
  // stays crisp, because mapbox mipmaps its own rasters. Hence trilinear,
  // plus anisotropy: that is what recovers the foreshortened axis, which
  // mipmapping ALONE would blur away (it picks a LOD for the worse axis).
  // WebGL2 (mapbox-gl v3 requires it), so NPOT mipmaps are legal.
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (anisoExt && maxAniso > 1) {
    gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
  }
}
