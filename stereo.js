/* World coordinates and lens model used by clickGUI0.01.py. No display transforms here. */
const Stereo = (() => {
  function shape(value, dims) {
    if (!dims.length)
      return Number.isFinite(value);
    return Array.isArray(value) && value.length === dims[0] && value.every(v => shape(v, dims.slice(1)));
  }
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

  function calibration(raw) {
    if (!raw)
      throw Error("キャリブレーション未読込");
    const K = raw.K ?? raw.camera_matrix, d = raw.d ?? raw.dist_coeffs;
    const R = raw.R ?? raw.rmat, t = raw.t ?? raw.tvec;
    for (const [name, data, dims] of [
             ["K", K, [2, 3, 3]], ["d", d, [2, 8]], ["R", R, [2, 3, 3]], ["t", t, [2, 3, 1]]]) {
      if (!shape(data, dims))
        throw Error(name + " は " + dims.join("×") + " の有限数配列が必要です");
    }
    const cameras = K.map((k, i) => {
      if (k[0][0] <= 0 || k[1][1] <= 0)
        throw Error("焦点距離が不正です");
      const extrinsic = R[i].map((row, j) => [...row, t[i][j][0]]);
      const P = k.map(row => [0, 1, 2, 3].map(j => dot(row, extrinsic.map(r => r[j]))));
      const center = [0, 1, 2].map(j => -dot(R[i].map(row => row[j]), t[i].flat()));
      return {k, d: d[i], P, center};
    });
    if (distance(cameras[0].center, cameras[1].center) < 1e-12)
      throw Error("カメラ中心が一致しています");
    return cameras;
  }

  function undistort(point, {k, d}) {
    const x0 = (point[0] - k[0][2]) / k[0][0], y0 = (point[1] - k[1][2]) / k[1][1];
    let x = x0, y = y0;
    // cv2.undistortPoints defaults to five inverse distortion iterations, P=K.
    for (let iter = 0; iter < 5; iter++) {
      const r = x * x + y * y;
      const inverse =
          (1 + r * (d[5] + r * (d[6] + r * d[7]))) / (1 + r * (d[0] + r * (d[1] + r * d[4])));
      if (inverse < 0) {
        x = x0;
        y = y0;
        break;
      }
      const dx = 2 * d[2] * x * y + d[3] * (r + 2 * x * x);
      const dy = d[2] * (r + 2 * y * y) + 2 * d[3] * x * y;
      x = (x0 - dx) * inverse;
      y = (y0 - dy) * inverse;
    }
    const homogeneous = k.map(row => dot(row, [x, y, 1]));
    return [homogeneous[0] / homogeneous[2], homogeneous[1] / homogeneous[2]];
  }

  // One-sided Jacobi SVD of the four DLT rows. V's least singular column is h.
  function nullVector(rows) {
    const scale = Math.max(...rows.flat().map(Math.abs));
    if (!(scale > 0 && Number.isFinite(scale)))
      return null;
    const cols = [0, 1, 2, 3].map(j => rows.map(row => row[j] / scale));
    const vectors = cols.map((_, i) => cols.map((__, j) => Number(i === j)));
    for (let sweep = 0; sweep < 40; sweep++) {
      let rotated = false;
      for (let p = 0; p < 3; p++)
        for (let q = p + 1; q < 4; q++) {
          const a = dot(cols[p], cols[p]), b = dot(cols[q], cols[q]), g = dot(cols[p], cols[q]);
          if (Math.abs(g) <= 4 * Number.EPSILON * Math.sqrt(a * b))
            continue;
          const z = (b - a) / (2 * g);
          const tangent = (z < 0 ? -1 : 1) / (Math.abs(z) + Math.hypot(1, z));
          const c = 1 / Math.hypot(1, tangent), s = tangent * c;
          for (const basis of [cols, vectors])
            for (let i = 0; i < 4; i++) {
              const u = basis[p][i], v = basis[q][i];
              basis[p][i] = c * u - s * v;
              basis[q][i] = s * u + c * v;
            }
          rotated = true;
        }
      if (!rotated)
        break;
    }
    const order = cols.map((col, i) => ({i, n: Math.hypot(...col)})).sort((a, b) => a.n - b.n);
    if (order[1].n - order[0].n <= 1e-12 * order[3].n)
      return null;
    return vectors[order[0].i];
  }

  function triangulate(cameras, points) {
    if (!shape(points, [2, 2]))
      return {xyz: null, reason: "両画像の打点が必要です"};
    const rows = [];
    for (let i = 0; i < 2; i++) {
      const uv = undistort(points[i], cameras[i]), P = cameras[i].P;
      uv.forEach((v, j) => rows.push(P[j].map((a, k) => a - v * P[2][k])));
    }
    const h = nullVector(rows);
    if (!h || Math.abs(h[3]) < 1e-12)
      return {xyz: null, reason: "視線が退化、または無限遠です"};
    const xyz = h.slice(0, 3).map(x => x / h[3]);
    if (!xyz.every(Number.isFinite) || cameras.some(c => Math.abs(dot(c.P[2], h)) < 1e-13)) {
      return {xyz: null, reason: "投影を確定できません"};
    }
    return {xyz, reason: ""};
  }
  function distance(a, b) {
    return a && b ? Math.hypot(...a.map((x, i) => x - b[i])) : null;
  }
  function imageSizes(raw) {
    let sizes =
        raw?.imageSizes ?? raw?.image_sizes ?? raw?.imageSize ?? raw?.image_size ?? raw?.resolution;
    if (!sizes && raw) {
      const w = raw.image_width ?? raw.imageWidth, h = raw.image_height ?? raw.imageHeight;
      sizes = Array.isArray(w) && Array.isArray(h) ? w.map((x, i) => [x, h[i]]) : [w, h];
    }
    const pair = s => Array.isArray(s) ? s : [s?.width, s?.height];
    if (shape(pair(sizes), [2]))
      sizes = [pair(sizes), pair(sizes)];
    return [0, 1].map(i => {
      const v = pair(sizes?.[i]);
      return shape(v, [2]) && v.every(n => Number.isInteger(n) && n > 0) ? v : [null, null];
    });
  }
  function coordinateMap(video, config, index) {
    const label = "Camera " + (index + 1) + "：";
    if (![config.width, config.height].every(n => Number.isSafeInteger(n) && n > 0))
      throw Error(label + "キャリブ画像寸法を設定してください");
    if (config.mode === "affine") {
      const values = [config.sx, config.sy, config.ox, config.oy];
      if (!values.every(Number.isFinite) || config.sx <= 0 || config.sy <= 0)
        throw Error(label + "座標変換の倍率・移動量が不正です");
      return ([x, y]) => [x * config.sx + config.ox, y * config.sy + config.oy];
    }
    if (config.mode !== "identity")
      throw Error(label + "不明な画像座標変換です");
    if (video.width !== config.width || video.height !== config.height)
      throw Error(label + "画像寸法が異なります。変換内容を確認してください");
    return p => p;
  }
  return {calibration, triangulate, undistort, distance, imageSizes, coordinateMap};
})();
if (typeof module !== "undefined")
  module.exports = Stereo;
