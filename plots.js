const CanvasTools = (() => {
  function surface(canvas) {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "12px \"Inter\", sans-serif";
    return {ctx, w, h};
  }
  function pos(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function navigation(canvas, accept, move, tap, end, start, twoTap) {
    const pointers = new Map();
    const starts = new Map();
    let origin, began, moved = false, multi = false, stillTap = false;
    function geometry() {
      const [a, b] = pointers.values();
      return !b ?
          {p: a, span: 0} :
          {p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], span: Math.hypot(a[0] - b[0], a[1] - b[1])};
    }
    canvas.addEventListener("pointerdown", e => {
      if (!accept(e))
        return;
      if (pointers.size >= 2) {
        stillTap = false;
        return;
      }
      const p = pos(canvas, e);
      if (!pointers.size) {
        origin = p;
        began = performance.now();
        moved = false;
        multi = false;
        stillTap = e.pointerType === "touch";
        start?.(e);
      } else
        multi = true;
      starts.set(e.pointerId, p);
      pointers.set(e.pointerId, p);
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId))
        return;
      const p = pos(canvas, e);
      const down = starts.get(e.pointerId);
      if (Math.hypot(p[0] - down[0], p[1] - down[1]) >= 4)
        stillTap = false;
      if (twoTap && multi && stillTap)
        return;
      if (!multi && !moved && Math.hypot(p[0] - origin[0], p[1] - origin[1]) < 4)
        return;
      moved = true;
      const before = geometry();
      pointers.set(e.pointerId, p);
      const after = geometry();
      move(
          before.p, after.p, before.span > 0 && after.span > 0 ? after.span / before.span : 1,
          multi || e.shiftKey);
    });
    function finish(e) {
      if (!pointers.delete(e.pointerId))
        return;
      const down = starts.get(e.pointerId), p = pos(canvas, e);
      if (e.type !== "pointerup" || Math.hypot(p[0] - down[0], p[1] - down[1]) >= 4)
        stillTap = false;
      starts.delete(e.pointerId);
      if (!pointers.size) {
        if (e.type === "pointerup" && !multi && !moved && performance.now() - began < 450)
          tap?.(pos(canvas, e));
        if (multi && !moved && stillTap && performance.now() - began < 300 && twoTap) {
          twoTap();
          return;
        }
        if (multi || moved)
          end?.();
      }
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(type, finish);
  }
  function marker(ctx, x, y, r, color, diamond = false) {
    ctx.beginPath();
    if (diamond) {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else
      ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  return {surface, pos, navigation, marker};
})();

function createPlots(s, api) {
  const space = document.getElementById("space");
  const series = ["X", "Y", "Z", "Distance"].map(label => ({
    canvas: document.getElementById("series" + label),
    hint: document.getElementById("hint" + label),
    value: document.getElementById("value" + label),
    domain: null
  }));
  const targetColor = "#10786a", refColor = "#b46027", grid = "#dce2db";
  let hits = [];
  const defaultView = () =>
      ({yaw: -0.5, pitch: 0.27, zoom: 1, panX: 0, panY: 0, center: [0, 0, 0], span: 1, fitted: false});
  function range() {
    const n = api.count();
    return s.scope === "all" ? [0, n - 1] :
                               [Math.max(0, s.frame - s.radius), Math.min(n - 1, s.frame + s.radius)];
  }
  function visiblePoints(visit) {
    if (!api.enabled())
      return;
    const [lo, hi] = range();
    for (let i = lo; i <= hi; i++) {
      const p = api.xyz(s.id, i);
      if (p)
        visit(p);
    }
    for (let id = 0; id < s.names.length; id++) {
      const p = api.xyz(id, s.frame);
      if (p)
        visit(p);
    }
  }
  function fitSpace() {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    visiblePoints(p => p.forEach((v, j) => {
      low[j] = Math.min(low[j], v);
      high[j] = Math.max(high[j], v);
    }));
    if (!Number.isFinite(low[0]))
      return;
    s.view3.center = low.map((x, j) => (x + high[j]) / 2);
    s.view3.span = Math.hypot(...low.map((x, j) => high[j] - x)) ||
        Math.max(1, ...low.map(x => Math.abs(x) * 0.05));
    Object.assign(s.view3, {zoom: 1, panX: 0, panY: 0, fitted: true});
  }
  function drawSpace() {
    const {ctx, w, h} = CanvasTools.surface(space), v = s.view3;
    hits = [];
    if (!v.fitted && api.enabled())
      fitSpace();
    const scale = Math.min(w, h) * 0.78 * v.zoom / v.span;
    const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw), cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    function rotate([x, y, z]) {
      return [cy * x + sy * z, -sp * sy * x + cp * y + sp * cy * z];
    }
    function project(p) {
      const [x, y] = rotate(p.map((q, j) => q - v.center[j]));
      return [w / 2 + v.panX + x * scale, h / 2 + v.panY - y * scale];
    }
    function line(a, b, color, dash = []) {
      ctx.beginPath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Orientation triad stays in the corner when the world view is panned.
    const base = [32, h - 29];
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((axis, j) => {
      const [x, y] = rotate(axis), end = [base[0] + 22 * x, base[1] - 22 * y];
      line(base, end, ["#a6533c", "#347c5f", "#416d9e"][j]);
      ctx.fillStyle = "#42514c";
      ctx.fillText("XYZ"[j], end[0] + 2, end[1] - 2);
    });
    let prev = null, any = false;
    const [lo, hi] = range(), f = s.frame, ref = s.refs[s.id];
    for (let i = lo; api.enabled() && i <= hi; i++) {
      const xyz = api.xyz(s.id, i);
      if (!xyz) {
        prev = null;
        continue;
      }
      const p = project(xyz);
      any = true;
      if (prev)
        line(prev, p, targetColor, i > f ? [4, 3] : []);
      ctx.fillStyle = targetColor;
      ctx.beginPath();
      ctx.arc(...p, 2, 0, 2 * Math.PI);
      ctx.fill();
      hits.push({p, i});
      prev = p;
    }
    const current = api.xyz(s.id, f), reference = api.xyz(ref, f);
    if (current && reference)
      line(project(current), project(reference), refColor);
    function show(id, p, r, color, diamond, label) {
      if (!p)
        return;
      any = true;
      const [x, y] = project(p);
      CanvasTools.marker(ctx, x, y, r, color, diamond);
      if (label) {
        ctx.fillStyle = color;
        ctx.fillText(api.name(id), x + 7, y + (diamond ? 14 : -7));
      }
    }
    for (let id = 0; id < s.names.length; id++)
      if (id !== s.id && id !== ref)
        show(id, api.xyz(id, f), 3, "#88958e", false, s.otherNames);
    show(ref, reference, 6, refColor, true, true);
    show(s.id, current, 6, targetColor, false, true);
    document.getElementById("spaceHint").textContent = any ? "" : api.reason();
  }
  function sample(channel, i) {
    if (channel === 3)
      return api.dist(s.id, i);
    return api.xyz(s.id, i)?.[channel] ?? null;
  }
  function bounds(channel, lo, hi) {
    let min = Infinity, max = -Infinity;
    for (let i = lo; i <= hi; i++) {
      const v = sample(channel, i);
      if (v != null) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (!Number.isFinite(min))
      return null;
    const pad = (max - min) * 0.12 || Math.max(Math.abs(min) * 0.04, 0.01);
    return [min - pad, max + pad];
  }
  function number(value) {
    return Number(value.toPrecision(4)).toString();
  }
  function drawSeries() {
    const [lo, hi] = range();
    const colors = ["#347b62", "#a15e2e", "#3d6899", targetColor];
    series.forEach((chart, ch) => {
      const {ctx, w, h} = CanvasTools.surface(chart.canvas);
      const left = 51, right = Math.max(left + 1, w - 10), y0 = 10, y1 = Math.max(11, h - 23);
      const x = i => hi === lo ? (left + right) / 2 : left + (right - left) * (i - lo) / (hi - lo);
      chart.domain = hi >= lo ? {lo, hi, left, right} : null;
      if (!s.axes[ch] && api.enabled())
        s.axes[ch] = bounds(ch, lo, hi);
      const extent = s.axes[ch] || [0, 1], [min, max] = extent;
      const y = v => y1 - (v - min) * (y1 - y0) / (max - min);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y0);
      ctx.lineTo(left, y1);
      ctx.lineTo(right, y1);
      ctx.stroke();
      ctx.fillStyle = "#52625a";
      if (s.axes[ch]) {
        ctx.textAlign = "right";
        ctx.fillText(number(max), left - 4, y0 + 9);
        ctx.fillText(number(min), left - 4, y1);
        ctx.textAlign = "left";
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left - 4, y0 - 2, right - left + 8, Math.max(1, y1 - y0 + 4));
      ctx.clip();
      if (hi >= lo) {
        ctx.strokeStyle = "#a2b5ab";
        ctx.beginPath();
        ctx.moveTo(x(s.frame), y0);
        ctx.lineTo(x(s.frame), y1);
        ctx.stroke();
      }
      ctx.strokeStyle = colors[ch];
      ctx.fillStyle = colors[ch];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let fresh = true, any = false;
      for (let i = lo; api.enabled() && i <= hi; i++) {
        const v = sample(ch, i);
        if (v == null) {
          fresh = true;
          continue;
        }
        any = true;
        if (fresh) {
          ctx.moveTo(x(i), y(v));
          ctx.fillRect(x(i) - 1, y(v) - 1, 2, 2);
        } else
          ctx.lineTo(x(i), y(v));
        fresh = false;
      }
      ctx.stroke();
      const v = sample(ch, s.frame);
      if (v != null)
        CanvasTools.marker(ctx, x(s.frame), y(v), 4, colors[ch]);
      ctx.restore();
      ctx.fillStyle = "#65736a";
      if (hi >= lo) {
        ctx.fillText(String(lo + 1), left, h - 6);
        ctx.textAlign = "right";
        ctx.fillText(String(hi + 1), right, h - 6);
      }
      ctx.textAlign = "center";
      ctx.fillText("Frame", (left + right) / 2, h - 6);
      ctx.textAlign = "left";
      chart.value.textContent = v == null ? "—" : number(v) + " " + (s.unit || "単位未設定");
      chart.value.title = chart.value.textContent;
      chart.hint.textContent = any ? "" : !api.enabled() ? "3D未計算" :
          ch === 3 && s.refs[s.id] == null ? "参照IDを選択" : "表示範囲に打点なし";
    });
  }
  CanvasTools.navigation(
      space, e => e.button === 0,
      (a, b, factor, pan) => {
        const v = s.view3;
        v.fitted = true;
        if (pan) {
          const zoom = Math.min(100, Math.max(0.02, v.zoom * factor)), k = zoom / v.zoom;
          v.panX = b[0] - space.clientWidth / 2 - (a[0] - space.clientWidth / 2 - v.panX) * k;
          v.panY = b[1] - space.clientHeight / 2 - (a[1] - space.clientHeight / 2 - v.panY) * k;
          v.zoom = zoom;
        } else {
          v.yaw += (b[0] - a[0]) * 0.012;
          v.pitch += (b[1] - a[1]) * 0.012;
        }
        api.draw();
      },
      p => {
        let nearest = null, best = 10;
        for (const hit of hits) {
          const d = Math.hypot(p[0] - hit.p[0], p[1] - hit.p[1]);
          if (d < best) {
            nearest = hit;
            best = d;
          }
        }
        if (nearest)
          api.go(nearest.i);
      },
      api.changed);
  space.addEventListener("wheel", e => {
    e.preventDefault();
    s.view3.fitted = true;
    s.view3.zoom = Math.min(100, Math.max(0.02, s.view3.zoom * Math.exp(-e.deltaY * 0.002)));
    api.draw();
    api.changed();
  }, {passive: false});
  series.forEach(chart => {
    CanvasTools.navigation(chart.canvas, e => e.button === 0, () => {}, p => {
      if (!chart.domain)
        return;
      const {lo, hi, left, right} = chart.domain;
      api.go(Math.round(lo + Math.min(1, Math.max(0, (p[0] - left) / (right - left))) * (hi - lo)));
    });
  });
  function showProgress(message) {
    hits = [];
    CanvasTools.surface(space);
    document.getElementById("spaceHint").textContent = message;
    series.forEach(chart => {
      chart.domain = null;
      CanvasTools.surface(chart.canvas);
      chart.hint.textContent = message;
      chart.value.textContent = "—";
    });
  }
  return {defaultView, drawSpace, drawSeries, fitSpace, range, showProgress};
}
