/* World coordinates and lens model used by clickGUI0.01.py. No display transforms here. */
const Stereo = (() => {
  function shape(value, dims) {
    if (!dims.length)
      return Number.isFinite(value);
    return Array.isArray(value) && value.length === dims[0] && value.every(v => shape(v, dims.slice(1)));
  }
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const multiply = (m, v) => m.map(row => dot(row, v));
  const transposeMultiply = (m, v) => [0, 1, 2].map(j => dot(m.map(row => row[j]), v));
  function inverse3(m) {
    const co = [cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1])], det = dot(m[0], co[0]);
    if (!Number.isFinite(det) || det === 0)
      throw Error("内部パラメータ行列が不正です");
    return [0, 1, 2].map(j => co.map(row => row[j] / det));
  }

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
      return {k, inverseK: inverse3(k), r: R[i], d: d[i], P, center};
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

  // Apply the same OpenCV rational eight-coefficient lens model to an ideal pixel.
  function distort(point, {k, inverseK, d}) {
    const ray = multiply(inverseK, [...point, 1]), x = ray[0] / ray[2], y = ray[1] / ray[2];
    const r2 = x*x + y*y;
    const denominator = 1 + r2 * (d[5] + r2 * (d[6] + r2 * d[7]));
    if (Math.abs(denominator) < 1e-12)
      return null;
    const radial = (1 + r2 * (d[0] + r2 * (d[1] + r2 * d[4]))) / denominator;
    const xd = x*radial + 2*d[2]*x*y + d[3]*(r2 + 2*x*x);
    const yd = y*radial + d[2]*(r2 + 2*y*y) + 2*d[3]*x*y;
    const q = multiply(k, [xd, yd, 1]), p = [q[0]/q[2], q[1]/q[2]];
    return p.every(Number.isFinite) ? p : null;
  }

  // A point in the source camera defines an epipolar plane through both camera centres.
  // Return ax+by+c=0 in UNDISTORTED target calibration pixels, in either camera direction.
  function epipolarLine(cameras, sourceIndex, point) {
    if (![0, 1].includes(sourceIndex) || !shape(point, [2]))
      return null;
    const source = cameras[sourceIndex], target = cameras[1-sourceIndex];
    const ray = multiply(source.inverseK, [...undistort(point, source), 1]);
    const direction = multiply(target.r, transposeMultiply(source.r, ray));
    const baseline = multiply(target.r, source.center.map((v, i) => v-target.center[i]));
    const plane = cross(baseline.map(v => v/Math.hypot(...baseline)),
                        direction.map(v => v/Math.hypot(...direction)));
    if (Math.hypot(...plane) < 1e-12)
      return null; // Source point is an epipole: there is no unique line.
    const line = transposeMultiply(target.inverseK, plane), norm = Math.hypot(line[0], line[1]);
    return norm > 1e-14 && line.every(Number.isFinite) ? line.map(v => v/norm) : null;
  }

  // Trace that line back onto the raw (distorted) image. Bounds are the video's rectangle
  // expressed in target calibration coordinates, including any confirmed resize/crop mapping.
  function epipolarCurve(cameras, sourceIndex, point, bounds) {
    const line = epipolarLine(cameras, sourceIndex, point);
    if (!line || !shape(bounds, [2, 2]) || bounds[1].some((v, i) => v <= bounds[0][i]))
      return [];
    const target = cameras[1-sourceIndex], border = [], distorted = target.d.some(v => v !== 0);
    for (let i = 0; i <= 32; i++) {
      const u = i/32, x = bounds[0][0]*(1-u)+bounds[1][0]*u,
            y = bounds[0][1]*(1-u)+bounds[1][1]*u;
      for (const p of [[x,bounds[0][1]], [x,bounds[1][1]], [bounds[0][0],y], [bounds[1][0],y]]) {
        const q = distorted ? undistort(p, target) : p;
        if (q.every(Number.isFinite)) border.push(q);
      }
    }
    if (!border.length) return [];
    const low = [0, 1].map(i => Math.min(...border.map(p => p[i])));
    const high = [0, 1].map(i => Math.max(...border.map(p => p[i])));
    const origin = [-line[2]*line[0], -line[2]*line[1]], along = [-line[1], line[0]];
    let start = -Infinity, end = Infinity;
    for (let i = 0; i < 2; i++) {
      const margin = Math.max(2, (high[i]-low[i])*0.05);
      low[i] -= margin; high[i] += margin;
      if (Math.abs(along[i]) < 1e-12) {
        if (origin[i] < low[i] || origin[i] > high[i]) return [];
      } else {
        const a = (low[i]-origin[i])/along[i], b = (high[i]-origin[i])/along[i];
        start = Math.max(start, Math.min(a,b)); end = Math.min(end, Math.max(a,b));
      }
    }
    if (!(end > start) || !Number.isFinite(start+end)) return [];
    const sample = t => {
      const p = origin.map((v,i) => v+t*along[i]);
      return distorted ? distort(p, target) : p;
    };
    if (!distorted) return [sample(start), sample(end)];
    const path = [sample(start)], span = Math.hypot(high[0]-low[0], high[1]-low[1]);
    function trace(a, p, b, q, depth) {
      if (path.length >= 4096) { path.push(null); return; }
      const mid = (a+b)/2, m = sample(mid);
      const error = p && q && m ? Math.hypot(...m.map((v,i) => v-(p[i]+q[i])/2)) : Infinity;
      const length = p && q ? distance(p,q) : Infinity;
      if (depth < 10 && (error > 0.025 || length > 24)) {
        trace(a,p,mid,m,depth+1); trace(mid,m,b,q,depth+1);
      } else {
        // Break the path at poles or unconverged sections; never draw across a singularity.
        if (error > 0.1 || length > 2*span) path.push(null);
        path.push(q);
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = start+(end-start)*i/16, b = start+(end-start)*(i+1)/16;
      trace(a,sample(a),b,sample(b),0);
    }
    return path;
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
  // World XYZ -> distorted calibration-image pixels (the inverse of undistort + DLT).
  function project(camera, xyz) {
    if (!camera || !shape(xyz, [3]))
      return null;
    const q = multiply(camera.P, [...xyz, 1]);
    if (!q.every(Number.isFinite) || q[2] <= 1e-12)
      return null;
    return distort([q[0] / q[2], q[1] / q[2]], camera);
  }
  // Natural cubic spline of XYZ against frame number. No extrapolation or smoothing.
  // Solve the tridiagonal system for second derivatives, once per changed trajectory.
  function temporalSpline(frames, points) {
    const n = frames.length;
    if (n < 2 || !shape(points, [n, 3]) ||
        !frames.every((f, i) => Number.isFinite(f) && (!i || f > frames[i - 1])))
      return null;
    const h = frames.slice(1).map((f, i) => f - frames[i]);
    const upper = Array(n).fill(0), second = Array.from({length: n}, () => [0, 0, 0]);
    for (let i = 1; i < n - 1; i++) {
      const diagonal = 2 * (h[i - 1] + h[i]) - h[i - 1] * upper[i - 1];
      upper[i] = h[i] / diagonal;
      for (let j = 0; j < 3; j++) {
        const rhs = 6 * ((points[i + 1][j] - points[i][j]) / h[i] -
                         (points[i][j] - points[i - 1][j]) / h[i - 1]);
        second[i][j] = (rhs - h[i - 1] * second[i - 1][j]) / diagonal;
      }
    }
    for (let i = n - 2; i > 0; i--)
      for (let j = 0; j < 3; j++) second[i][j] -= upper[i] * second[i + 1][j];
    return f => {
      if (!Number.isFinite(f) || f < frames[0] || f > frames[n - 1])
        return null;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (frames[mid] <= f) lo = mid;
        else hi = mid;
      }
      if (f === frames[lo]) return points[lo].slice();
      if (f === frames[hi]) return points[hi].slice();
      const a = (frames[hi] - f) / h[lo], b = 1 - a;
      const p = points[lo].map((v, j) => a * v + b * points[hi][j] + h[lo] ** 2 / 6 *
          ((a ** 3 - a) * second[lo][j] + (b ** 3 - b) * second[hi][j]));
      return p.every(Number.isFinite) ? p : null;
    };
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
  return {calibration, triangulate, undistort, distort, epipolarLine, epipolarCurve,
          distance, project, temporalSpline, imageSizes, coordinateMap};
})();
if (typeof module !== "undefined")
  module.exports = Stereo;
