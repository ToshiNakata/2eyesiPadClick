/* Stereo edition of the singleMovie canvas/buffer editor. All frame and ID indices are zero based. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const int = (n, defaultValue, min = 0) => Number.isSafeInteger(n) && n >= min ? n : defaultValue;
  const number = (n, fallback) => Number.isFinite(n) ? n : fallback;
  const imageView = () => ({scale: 1, panX: 0, panY: 0});
  const profile = ([width, height] = []) =>
      ({width: width ?? 1248, height: height ?? 1024, mode: "identity", sx: 1, sy: 1, ox: 0, oy: 0});
  const s = {
    videos: [],
    buffers: [],
    frame: 0,
    wanted: 0,
    id: 0,
    active: 0,
    ready: false,
    names: Array(10).fill(""),
    refs: Array(10).fill(null),
    x: [[], []],
    y: [[], []],
    views: [imageView(), imageView()],
    frameStep: 1,
    advance: "none",
    trail: 5,
    gamma: 1,
    step: 0.25,
    scope: "local",
    radius: 20,
    axes: [],
    split: 60,
    otherNames: false,
    epipolar: false,
    calib: null,
    calibName: "",
    unit: "",
    configs: [profile(), profile()],
    extra: {},
    videoMeta: [{}, {}],
    dirty: false
  };
  const count = () => s.videos[0]?.frameCount || 0;
  const name = id => s.names[id] ? (id + 1) + " " + s.names[id] : String(id + 1);
  const cameras = [], staged = [null, null], history = [], future = [];
  const backupKey = "clickiPad.stereo.autosave.v2", oldKey = "clickiPad.autosave.v1";
  let geometry = null, maps = null, geometryError = "", xyzCache = [], distanceCache = [],
      rangeJob = null, epipolarCache = null;
  let drag = null, busyPair = false, queue = null, running = false, generation = 0, frameError = "",
      backupError = "", autosaveTimer, drawTicket, loadController = null, pendingAnnotation = null;
  const plots = createPlots(
      s, {count, xyz, dist, name, reason, enabled: () => !!geometry, draw: schedule, go, changed});
  s.view3 = plots.defaultView();

  function observation(c, id, f) {
    const x = s.x[c]?.[id]?.[f], y = s.y[c]?.[id]?.[f];
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  function result(id, f) {
    if (!geometry || id == null || id < 0 || id >= s.names.length || f < 0 || f >= count())
      return null;
    const row = xyzCache[id] ??= [];
    if (row[f] === undefined) {
      const points = maps.map((map, c) => {
        const p = observation(c, id, f);
        return p && map(p);
      });
      row[f] = Stereo.triangulate(geometry, points);
    }
    return row[f];
  }
  function xyz(id, f) {
    return result(id, f)?.xyz ?? null;
  }
  function dist(id, f) {
    const ref = s.refs[id];
    if (!geometry || ref == null)
      return null;
    const row = distanceCache[id] ??= [];
    if (row[f] === undefined)
      row[f] = Stereo.distance(xyz(id, f), xyz(ref, f));
    return row[f];
  }
  function reason() {
    return !count() ? "2本の動画を開いてください" : geometryError || result(s.id, s.frame)?.reason || "";
  }
  function configure(resetView = false) {
    epipolarCache = null;
    xyzCache = [];
    distanceCache = [];
    geometry = null;
    maps = null;
    geometryError = "";
    try {
      const cal = Stereo.calibration(s.calib);
      if (!count())
        throw Error("動画を開いて寸法を照合してください");
      maps = s.videos.map((v, i) => Stereo.coordinateMap(v, s.configs[i], i));
      geometry = cal;
    } catch (e) {
      geometryError = e.message;
    }
    if (resetView) {
      s.view3 = plots.defaultView();
      s.axes = [];
    }
    $("geometryStatus").textContent = geometry ? "3D計算が有効です" : geometryError;
    schedule();
  }
  function writePoint(c, id, f, p) {
    s.x[c][id][f] = p?.[0] ?? null;
    s.y[c][id][f] = p?.[1] ?? null;
    if (xyzCache[id])
      delete xyzCache[id][f];
    s.refs.forEach((ref, i) => {
      if ((i === id || ref === id) && distanceCache[i])
        delete distanceCache[i][f];
    });
    schedule();
  }
  function record(c, id, f, before, after) {
    if (before?.[0] === after?.[0] && before?.[1] === after?.[1])
      return false;
    history.push({c, id, f, before, after});
    if (history.length > 500)
      history.shift();
    future.length = 0;
    changed();
    return true;
  }
  function changePoint(dx, dy, remove = false) {
    if (!s.ready || busyPair || drag)
      return;
    const c = s.active, p = observation(c, s.id, s.frame);
    if (!p)
      return;
    const v = s.videos[c],
          after = remove ?
        null :
        [clamp(p[0] + dx * s.step, 0, v.width), clamp(p[1] + dy * s.step, 0, v.height)];
    writePoint(c, s.id, s.frame, after);
    record(c, s.id, s.frame, p, after);
  }
  function historyStep(back) {
    if (!s.ready || busyPair || drag)
      return;
    const from = back ? history : future, entry = from.pop();
    if (!entry)
      return;
    (back ? future : history).push(entry);
    writePoint(entry.c, entry.id, entry.f, back ? entry.before : entry.after);
    s.active = entry.c;
    selectId(entry.id);
    go(entry.f);
    changed();
  }
  function resizeIds(n) {
    for (let i = 0; i < 2; i++)
      for (const a of [s.x, s.y]) {
        while (a[i].length < n) a[i].push(Array(count()).fill(null));
        a[i].length = n;
      }
    while (s.names.length < n) {
      s.names.push("");
      s.refs.push(null);
    }
    s.names.length = n;
    s.refs.length = n;
    s.refs = s.refs.map(ref => ref != null && ref < n ? ref : null);
    s.id = clamp(s.id, 0, n - 1);
  }
  function selectId(id) {
    if (s.id !== id) {
      s.id = id;
      s.axes = [];
    }
    selectors();
    schedule();
  }
  function selectors() {
    $("target").replaceChildren(...s.names.map((_, id) => new Option(name(id), id)));
    $("target").value = s.id;
    $("reference")
        .replaceChildren(
            new Option("なし", ""),
            ...s.names.flatMap((_, id) => id === s.id ? [] : [new Option(name(id), id)]));
    $("reference").value = s.refs[s.id] ?? "";
    $("pointName").value = s.names[s.id];
  }
  function go(index) {
    if (!count() || busyPair || !Number.isFinite(index))
      return;
    finishDrag(true);
    const f = clamp(Math.round(index), 0, count() - 1);
    if (s.ready && f === s.frame) {
      s.wanted = f;
      return;
    }
    s.wanted = f;
    s.ready = false;
    frameError = "";
    queue = {f, gen: ++generation, videos: s.videos};
    // Lock edits synchronously, even before the first animation frame after a slider event.
    refresh();
    pump();
  }
  async function pump() {
    if (running)
      return;
    running = true;
    try {
      while (queue) {
        const req = queue;
        queue = null;
        const frames = await Promise.allSettled(req.videos.map(v => v.frame(req.f)));
        if (req.gen !== generation)
          continue;
        const failed = frames.find(v => v.status === "rejected");
        if (failed) {
          frameError = failed.reason.message;
          s.ready = false;
          refresh();
          continue;
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (req.gen !== generation)
          continue;
        s.buffers = frames.map(v => v.value);
        s.frame = req.f;
        $("frameNo").value = s.frame + 1;
        drawImages();
        s.ready = true;
        if (preparePlotRange()) {
          plots.drawSpace();
          plots.drawSeries();
        }
        refresh();
        queueBackup();
      }
    } finally {
      running = false;
    }
  }
  function frameStep(direction) {
    go(s.wanted + direction * s.frameStep);
  }
  function blankProject() {
    s.x = [[], []];
    s.y = [[], []];
    s.extra = {};
    s.videoMeta = [{}, {}];
    s.views = [imageView(), imageView()];
    s.names = Array(s.names.length).fill("");
    s.refs = Array(s.names.length).fill(null);
    s.active = 0;
    s.id = 0;
    s.axes = [];
    s.view3 = plots.defaultView();
    s.dirty = false;
    resizeIds(s.names.length);
    history.length = 0;
    future.length = 0;
  }
  async function loadPair() {
    if (busyPair)
      return;
    const files = staged.map((file, i) => file || s.videos[i]?.file);
    if (!files.every(Boolean)) {
      message("Camera 1 と Camera 2 の両方を指定してください");
      return;
    }
    busyPair = true;
    const controller = loadController = new AbortController();
    finishDrag(false);
    refresh();
    const progress = ["開始中", "開始中"];
    const report = (c, value) => {
      if (controller.signal.aborted) return;
      progress[c] = value;
      message(progress.map((phase, i) => "Camera " + (i + 1) + "：" + phase).join("\n"));
    };
    const next = [];
    try {
      const entries = await Promise.allSettled(
          files.map((file, c) => StereoMedia.open(file, {
            signal: controller.signal, onProgress: value => report(c, value)
          })));
      entries.forEach(r => {
        if (r.status === "fulfilled")
          next.push(r.value);
      });
      const error = entries.find(r => r.status === "rejected");
      if (error)
        throw error.reason;
      if (next[0].frameCount !== next[1].frameCount)
        throw Error(
            "総フレーム数が一致しません。" +
            next.map(v => v.name + " = " + v.frameCount + " F").join(" ／ "));
      next.forEach((v, i) => v.file = files[i]);
      if (pendingAnnotation) prepareImport(pendingAnnotation, next);
      const same = s.videos.length === 2 &&
          next.every(
              (v, i) => ["name", "frameCount", "width", "height", "contentTag"].every(
                  k => v[k] === s.videos[i][k]));
      const first = pendingAnnotation ? clamp(int(pendingAnnotation.currentFrame, 0), 0, next[0].frameCount - 1) :
          same ? s.frame : 0;
      const buffers = await Promise.all(next.map(async (v, c) => {
        report(c, v.frameCount + " F ／ フレーム " + (first + 1) + " を読込中");
        const buffer = await v.frame(first);
        report(c, v.frameCount + " F ／ 表示準備完了");
        return buffer;
      }));
      if (controller.signal.aborted) throw Error("読み込みを中止しました");
      if (!same && s.dirty && !confirm("現在の作業を新しい動画ペアに切り替えますか？")) {
        message("現在の作業を継続します");
        return;
      }
      const wasEmpty = !count();
      ++generation;
      queue = null;
      s.videos.forEach(v => v.close());
      s.videos = next.splice(0);
      if (!same) {
        blankProject();
        if (!wasEmpty) {
          s.calib = null;
          s.calibName = "";
          s.configs = [profile(), profile()];
          s.unit = "";
        }
      }
      s.frame = s.wanted = first;
      s.buffers = buffers;
      s.ready = false;
      frameError = "";
      staged.fill(null);
      configure();
      selectors();
      drawImages();
      s.ready = true;
      $("dialog").close();
      message("");
      syncSettings();
      busyPair = false;
      if (pendingAnnotation) {
        if (importData(pendingAnnotation)) pendingAnnotation = null;
        syncSettings();
      } else if (wasEmpty) {
        const backup = availableBackup(true);
        if (backup && confirm("この動画に対応する自動保存があります。復元しますか？"))
          importData(backup, true);
      }
    } catch (e) {
      message(controller.signal.aborted ? "読み込みを中止しました" : e.message);
    } finally {
      next.forEach(v => v.close());
      loadController = null;
      busyPair = false;
      refresh();
      schedule();
      if (s.frame !== s.wanted && !s.ready && !frameError)
        go(s.wanted);
    }
  }

  function transform(c) {
    const v = s.videos[c], view = s.views[c], canvas = cameras[c].canvas;
    const scale = Math.min(canvas.clientWidth / v.width, canvas.clientHeight / v.height) * view.scale;
    return {
      scale,
      ox: (canvas.clientWidth - v.width * scale) / 2 + view.panX,
      oy: (canvas.clientHeight - v.height * scale) / 2 + view.panY
    };
  }
  function world(c, [x, y]) {
    const t = transform(c);
    return [(x - t.ox) / t.scale, (y - t.oy) / t.scale];
  }
  function navigateImage(c, a, b, factor) {
    const anchor = world(c, a), v = s.views[c];
    v.scale = clamp(v.scale * factor, 0.3, 12);
    const t = transform(c);
    v.panX += b[0] - t.ox - anchor[0] * t.scale;
    v.panY += b[1] - t.oy - anchor[1] * t.scale;
    schedule();
  }
  const luts = new Map();
  function corrected(cam, raw) {
    if (s.gamma === 1)
      return raw;
    if (cam.gammaSource === raw && cam.gammaFrame === s.frame && cam.gamma === s.gamma)
      return cam.corrected;
    const cv = cam.corrected;
    cv.width = raw.width;
    cv.height = raw.height;
    const ctx = cv.getContext("2d", {willReadFrequently: true});
    ctx.drawImage(raw, 0, 0);
    const pixels = ctx.getImageData(0, 0, cv.width, cv.height), data = pixels.data;
    if (!luts.has(s.gamma))
      luts.set(
          s.gamma, Uint8Array.from({length: 256}, (_, i) => Math.round(255 * (i / 255) ** s.gamma)));
    const lut = luts.get(s.gamma);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
    ctx.putImageData(pixels, 0, 0);
    cam.gammaSource = raw;
    cam.gammaFrame = s.frame;
    cam.gamma = s.gamma;
    return cv;
  }
  function drawImages() {
    cameras.forEach((cam, c) => {
      cam.panel.hidden = c !== s.active;
      const raw = s.buffers[c];
      if (raw)
        s.videos[c].displayed = raw;
      if (cam.panel.hidden)
        return;
      const {ctx} = CanvasTools.surface(cam.canvas);
      if (!raw)
        return;
      const t = transform(c), loc = p => [t.ox + p[0] * t.scale, t.oy + p[1] * t.scale];
      ctx.drawImage(corrected(cam, raw), t.ox, t.oy, raw.width * t.scale, raw.height * t.scale);
      drawEpipolar(ctx, c, t, raw);
      ctx.strokeStyle = "#83e5bf";
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let f = Math.max(0, s.frame - s.trail); f <= Math.min(count() - 1, s.frame + s.trail); f++) {
        const p = observation(c, s.id, f);
        if (!p) {
          pen = false;
          continue;
        }
        const q = loc(p);
        if (pen)
          ctx.lineTo(...q);
        else
          ctx.moveTo(...q);
        pen = true;
        ctx.fillStyle = "#83e5bf";
        ctx.fillRect(q[0] - 1, q[1] - 1, 2, 2);
      }
      ctx.stroke();
      function mark(id) {
        const p = observation(c, id, s.frame);
        if (!p)
          return;
        const [x, y] = loc(p), target = id === s.id, ref = id === s.refs[s.id];
        const color = target ? "#34bea0" : ref ? "#ed9c55" : "#b5c3bd";
        CanvasTools.marker(ctx, x, y, target || ref ? 4 : 2.5, color, ref);
        if (target) {
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, 2 * Math.PI);
          ctx.strokeStyle = "#fff";
          ctx.stroke();
        }
        const label = name(id);
        ctx.strokeStyle = "#142922";
        ctx.lineWidth = 2.5;
        ctx.strokeText(label, x + 7, y - 6);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, x + 7, y - 6);
      }
      s.names.forEach((_, i) => {
        if (i !== s.id)
          mark(i);
      });
      mark(s.id);
      const p = observation(c, s.id, s.frame);
      cam.pixel.textContent = p ? p.map(v => v.toFixed(2)).join(", ") + " px" : "";
    });
  }
  function drawEpipolar(ctx, c, t, raw) {
    if (!s.epipolar || !geometry)
      return;
    const other = 1-c, point = observation(other, s.id, s.frame);
    if (!point)
      return;
    const key = [c, s.id, s.frame, ...point].join(",");
    if (epipolarCache?.key !== key) {
      const curve = Stereo.epipolarCurve(geometry, other, maps[other](point),
                                        [maps[c]([0,0]), maps[c]([raw.width,raw.height])]);
      const cfg = s.configs[c];
      epipolarCache = {key, curve: curve.map(p => p && (cfg.mode === "affine" ?
          [(p[0]-cfg.ox)/cfg.sx, (p[1]-cfg.oy)/cfg.sy] : p))};
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(t.ox, t.oy, raw.width*t.scale, raw.height*t.scale);
    ctx.clip();
    ctx.beginPath();
    let pen = false;
    for (const p of epipolarCache.curve) {
      if (!p) { pen = false; continue; }
      const q = [t.ox+p[0]*t.scale, t.oy+p[1]*t.scale];
      if (pen) ctx.lineTo(...q); else ctx.moveTo(...q);
      pen = true;
    }
    ctx.setLineDash([7,5]);
    ctx.strokeStyle = "#142922";
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = "#ffd45a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  function activate(c) {
    if (c !== s.active)
      finishDrag(true);
    s.active = c;
    refresh();
    drawImages();
    queueBackup();
  }
  function finishDrag(commit, advance = false) {
    if (!drag)
      return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    const after = observation(d.c, d.id, d.f);
    if (!commit) {
      writePoint(d.c, d.id, d.f, d.before);
      return;
    }
    const edited = record(d.c, d.id, d.f, d.before, after);
    if (advance && edited && d.created && after) {
      if (s.advance === "frame")
        frameStep(1);
      if (s.advance === "id")
        selectId(Math.min(s.id + 1, s.names.length - 1));
    }
    schedule();
  }
  function bindCamera(c) {
    const panel = $("cameraTemplate").content.firstElementChild.cloneNode(true),
          canvas = panel.querySelector("canvas");
    panel.querySelector("h2").textContent = "Camera " + (c + 1);
    canvas.setAttribute("aria-label", "Camera " + (c + 1) + " 打点画像");
    $("cameras").append(panel);
    const cam = {
      panel,
      canvas,
      pixel: panel.querySelector(".pixel"),
      corrected: document.createElement("canvas")
    };
    cameras.push(cam);
    panel.querySelector(".empty").onclick = () => {
      openSettings();
      $("file" + c).click();
    };
    panel.querySelector(".home").onclick = () => {
      activate(c);
      s.views[c] = imageView();
      schedule();
      changed();
    };
    panel.querySelector(".center").onclick = () => {
      activate(c);
      if (!count())
        return;
      const v = s.videos[c], p = observation(c, s.id, s.frame) || [v.width / 2, v.height / 2],
            t = transform(c);
      s.views[c].panX += canvas.clientWidth / 2 - (t.ox + p[0] * t.scale);
      s.views[c].panY += canvas.clientHeight / 2 - (t.oy + p[1] * t.scale);
      schedule();
      changed();
    };
    CanvasTools.navigation(
        canvas, e => c === s.active && count() && !drag &&
            (e.pointerType === "touch" || e.shiftKey || e.button === 1),
        (a, b, k) => {
          if (c === s.active && !drag)
            navigateImage(c, a, b, k);
        },
        null, changed, () => activate(c), () => historyStep(true));
    canvas.addEventListener("wheel", e => {
      if (!count() || drag)
        return;
      e.preventDefault();
      activate(c);
      const p = CanvasTools.pos(canvas, e);
      navigateImage(c, p, p, Math.exp(-e.deltaY * 0.002));
      changed();
    }, {passive: false});
    canvas.oncontextmenu = e => e.preventDefault();
    canvas.addEventListener("pointerdown", e => {
      if (c !== s.active || !s.ready || busyPair || drag || e.pointerType === "touch" ||
          e.button !== 0 || e.shiftKey)
        return;
      const screen = CanvasTools.pos(canvas, e), p = world(c, screen), v = s.videos[c];
      if (p[0] < 0 || p[1] < 0 || p[0] > v.width || p[1] > v.height)
        return;
      e.preventDefault();
      activate(c);
      canvas.setPointerCapture(e.pointerId);
      const observed = observation(c, s.id, s.frame), scale = transform(c).scale;
      // v1 files can contain only one finite coordinate. Undo must restore that raw pair exactly.
      const raw = [s.x[c][s.id][s.frame], s.y[c][s.id][s.frame]];
      const before = raw.every(value => value === null) ? null : raw;
      const hit = observed && Math.hypot(observed[0] - p[0], observed[1] - p[1]) * scale < 14;
      const d = {
        c,
        id: s.id,
        f: s.frame,
        before,
        created: !observed,
        pointer: e.pointerId,
        start: screen,
        offset: hit ? [before[0] - p[0], before[1] - p[1]] : [0, 0],
        deleted: false,
        moved: false
      };
      drag = d;
      if (!hit)
        writePoint(c, d.id, d.f, p);
      else
        d.timer = setTimeout(() => {
          if (drag === d) {
            d.deleted = true;
            writePoint(c, d.id, d.f, null);
          }
        }, 650);
    });
    function move(e) {
      const d = drag;
      if (!d || d.c !== c || d.pointer !== e.pointerId || d.deleted)
        return;
      const screen = CanvasTools.pos(canvas, e);
      if (!d.moved && Math.hypot(screen[0] - d.start[0], screen[1] - d.start[1]) < 2)
        return;
      clearTimeout(d.timer);
      d.moved = true;
      const p = world(c, screen), v = s.videos[c];
      writePoint(
          c, d.id, d.f, [clamp(p[0] + d.offset[0], 0, v.width), clamp(p[1] + d.offset[1], 0, v.height)]);
    }
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", e => {
      if (drag?.c === c && drag.pointer === e.pointerId) {
        move(e);
        finishDrag(true, true);
      }
    });
    for (const type of ["pointercancel", "lostpointercapture"])
      canvas.addEventListener(type, e => {
        if (drag?.c === c && drag.pointer === e.pointerId)
          finishDrag(false);
      });
  }

  function payload() {
    const data = {
      ...s.extra,
      schema: "clickiPad.annotation",
      version: 2,
      savedAt: new Date().toISOString(),
      n_movie: 2,
      n_point: s.names.length,
      currentFrame: s.frame,
      currentId: s.id,
      currentVideoIndex: s.active,
      currentReference: s.refs[s.id],
      pointNames: s.names,
      references: s.refs,
      x: s.x,
      y: s.y,
      calibration: s.calib,
      calibrationName: s.calibName,
      calibrationImages: s.configs,
      coordinates: {
        ...s.extra.coordinates,
        system: "world",
        depthAxis: "Z",
        cameraConvention: "X_cam = R * X_world + t",
        unit: s.unit
      },
      videos: s.videos.map((v, c) => ({
                             ...s.videoMeta[c],
                             camera: c + 1,
                             calibrationIndex: c,
                             name: v.name,
                             fileSize: v.file.size,
                             contentTag: v.contentTag,
                             width: v.width,
                             height: v.height,
                             frameCount: v.frameCount,
                             fps: v.fps,
                             variableFrameRate: v.variableFrameRate,
                             duration: v.duration
                           })),
      frameStep: s.frameStep,
      autoAdvance: s.advance,
      centerAfterPoint: false,
      trailFrames: s.trail,
      gamma: s.gamma,
      defaultFps: s.videos[0]?.fps ?? null,
      display: {
        ...s.extra.display,
        images: s.views,
        world: s.view3,
        axes: s.axes,
        scope: s.scope,
        radius: s.radius,
        split: s.split,
        otherNames: s.otherNames,
        epipolar: s.epipolar,
        nudge: s.step
      }
    };
    // If a v1 producer also stored flat calibration fields, keep those aliases consistent.
    for (const [key, alias] of [
             ["K", "camera_matrix"], ["d", "dist_coeffs"], ["R", "rmat"], ["t", "tvec"]]) {
      for (const field of [key, alias])
        if (field in data)
          data[field] = s.calib?.[key] ?? s.calib?.[alias] ?? null;
    }
    return data;
  }
  function validateSources(raw, sources = s.videos) {
    const videos = raw?.videos;
    if (!Array.isArray(videos) || ![1, 2].includes(videos.length))
      throw Error("動画名・寸法・総フレーム数を含む保存JSONが必要です");
    const single = videos.length === 1;
    if (single && raw.version === 2)
      throw Error("version 2 のカメラ数が不正です");
    const slots = videos.map((saved, i) => {
      if (!single)
        return i;
      const candidates = sources.flatMap(
          (v, c) =>
              v.name === saved?.name && ["width", "height", "frameCount"].every(k => v[k] === saved[k]) ?
              [c] :
              []);
      return candidates.length === 2 ? s.active : candidates[0];
    });
    videos.forEach((saved, i) => {
      const v = sources[slots[i]];
      if (!v || !saved || saved.name !== v.name)
        throw Error(
            "動画の割り当てが異なります。保存時の Camera " + (i + 1) + " は " + (saved?.name ?? "不明") +
            " です");
      for (const k of ["width", "height", "frameCount"])
        if (saved[k] !== v[k])
          throw Error(
              v.name + " の " + k + " が異なります（JSON " + saved[k] + " ／ 動画 " + v[k] + "）");
      // Old same-name projects used a whole-file CRC. Do not rescan gigabytes to compare it.
      // Compare sampled tags when available; keep old projects usable with explicit assignment.
      const legacySize = /^crc32-(\d+)-/.exec(saved.contentTag || "")?.[1];
      if ((saved.fileSize != null && saved.fileSize !== v.file.size) ||
          (legacySize && Number(legacySize) !== v.file.size) ||
          (saved.contentTag?.startsWith("sample-crc32-") && saved.contentTag !== v.contentTag))
        throw Error("Camera " + (i + 1) + " の動画の内容が保存時と異なります");
      if (raw.version === 2 &&
          (saved.camera !== i + 1 || saved.calibrationIndex !== i))
        throw Error("保存時のカメラ割り当てが不正です");
    });
    return slots;
  }
  function annotationShape(raw) {
    if (!raw || (raw.schema && raw.schema !== "clickiPad.annotation") ||
        ![1, 2].includes(raw.version ?? 1))
      throw Error("対応する打点JSON version 1 / 2 が必要です");
    if (!Array.isArray(raw.videos) || ![1, 2].includes(raw.videos.length) ||
        (raw.version === 2 && raw.videos.length !== 2) ||
        raw.videos.some(v => !v || typeof v.name !== "string" || !v.name ||
            ["width", "height", "frameCount"].some(k => !Number.isSafeInteger(v[k]) || v[k] < 1)))
      throw Error("動画名・寸法・総フレーム数を含む保存JSONが必要です");
    const ids = raw.n_point ?? raw.idCount ?? raw.x?.[0]?.length;
    if (!Number.isSafeInteger(ids) || ids < 1)
      throw Error("ID数が不正です");
    for (const axis of ["x", "y"]) {
      if (!Array.isArray(raw[axis]) || raw[axis].length !== raw.videos.length)
        throw Error(axis + " のカメラ数が不正です");
      for (const [c, rows] of raw[axis].entries()) {
        if (!Array.isArray(rows) || rows.length !== ids)
          throw Error(axis + " のID数が不正です");
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== raw.videos[c].frameCount ||
              !row.every(v => v === null || Number.isFinite(v)))
            throw Error(axis + " のフレーム数または座標が不正です");
        }
      }
    }
    return ids;
  }
  function prepareImport(raw, sources = s.videos) {
    const ids = annotationShape(raw), slots = validateSources(raw, sources);
    return {slots, ids};
  }
  async function readAnnotation(raw) {
    annotationShape(raw);
    if (count()) {
      try {
        validateSources(raw);
        if (importData(raw)) pendingAnnotation = null;
        syncSettings();
        return;
      } catch (error) {
        // Do not silently reorder an already open pair or accept different content under one name.
        if (raw.videos.every(saved => s.videos.some(v => v.name === saved.name))) throw error;
      }
    }
    pendingAnnotation = raw;
    const candidates = [...new Set([...staged, ...s.videos.map(v => v.file)].filter(Boolean))];
    for (let c = 0; c < 2; c++) {
      const expected = raw.videos[c];
      const matches = candidates.filter(f => f.name === expected?.name &&
          (expected.fileSize == null || f.size === expected.fileSize));
      staged[c] = matches.length === 1 && raw.videos.filter(v => v.name === expected.name).length === 1 ?
          matches[0] : null;
    }
    syncSettings();
    message("打点JSONを読み込みました。表示された動画を選ぶと、打点・キャリブレーションをまとめて復元します");
    if (staged.every(Boolean)) await loadPair();
  }
  function restoreDisplay(d = {}) {
    s.views = [0, 1].map(i => {
      const v = d.images?.[i] || {};
      return {
        ...v,
        scale: clamp(number(v.scale, 1), 0.3, 12),
        panX: number(v.panX, 0),
        panY: number(v.panY, 0)
      };
    });
    const v = d.world || {}, base = plots.defaultView();
    if (Array.isArray(v.center) && v.center.length === 3 && v.center.every(Number.isFinite) &&
        v.span > 0 && Number.isFinite(v.span)) {
      for (const k of ["yaw", "pitch", "panX", "panY"]) base[k] = number(v[k], base[k]);
      Object.assign(base, {
        zoom: clamp(number(v.zoom, 1), 0.02, 100),
        span: v.span,
        center: v.center.slice(),
        fitted: v.fitted === true
      });
    }
    s.view3 = base;
    s.axes = [0, 1, 2, 3].map(i => {
      const a = d.axes?.[i];
      return Array.isArray(a) && a.length === 2 && a.every(Number.isFinite) && a[1] > a[0] ? a.slice() :
                                                                                             null;
    });
    s.scope = d.scope === "all" ? "all" : "local";
    s.radius = int(d.radius, 20, 1);
    s.split = clamp(number(d.split, 60), 35, 75);
    s.otherNames = d.otherNames === true;
    s.epipolar = d.epipolar === true;
    s.step = [0.1, 0.25, 0.5, 1].includes(d.nudge) ? d.nudge : 0.25;
  }
  function importData(raw, recovery = false) {
    const {slots, ids} = prepareImport(raw), single = slots.length === 1;
    if (s.videos[0].name === s.videos[1].name &&
        !raw.videos.every(v => v.contentTag?.startsWith("sample-crc32-"))) {
      const assignment = single ? "編集対象 Camera " + (slots[0] + 1) + " に読み込みます。" :
                                  "保存順を Camera 1、Camera 2 として読み込みます。";
      if (!confirm(
              "同名動画で、旧JSONには現在の方式の識別情報がありません。" + assignment + "割り当てを確認しましたか？"))
        return false;
    }
    if (s.dirty &&
        !confirm(
            single ? "対応するカメラの打点を読み込んだ内容に置き換えますか？" :
                     "現在の作業を読み込んだ内容に置き換えますか？"))
      return false;
    finishDrag(false);
    const {x, y, ...metadata} = raw;
    if (single) {
      const hasPartner = [s.x, s.y].some(axis => axis[1 - slots[0]].some(row => row.some(Number.isFinite))) ||
          s.names.some(Boolean) || s.refs.some(r => r != null);
      resizeIds(hasPartner ? Math.max(ids, s.names.length) : ids);
      s.extra.singleMovieSources = {...s.extra.singleMovieSources, [slots[0]]: metadata};
    } else {
      s.extra = metadata;
      resizeIds(ids);
    }
    slots.forEach((c, i) => {
      s.x[c] = Array.from(
          {length: s.names.length}, (_, id) => x[i][id]?.slice() ?? Array(count()).fill(null));
      s.y[c] = Array.from(
          {length: s.names.length}, (_, id) => y[i][id]?.slice() ?? Array(count()).fill(null));
      s.videoMeta[c] = {...raw.videos[i]};
    });
    if (!single) {
      s.names = s.names.map((_, i) => typeof raw.pointNames?.[i] === "string" ? raw.pointNames[i] : "");
      s.refs = s.names.map((_, i) => {
        const r = raw.references?.[i];
        return Number.isInteger(r) && r >= 0 && r < ids && r !== i ? r : null;
      });
    }
    const flat = (raw.K || raw.camera_matrix) ? Object.fromEntries([
      "K", "d", "R", "t", "camera_matrix", "dist_coeffs", "rmat", "tvec", "reproj", "image_size",
      "imageSizes", "image_width", "image_height"
    ].filter(k => k in raw).map(k => [k, raw[k]])) :
                                                null;
    const calibration = raw.calibration ?? flat;
    if (calibration || raw.version === 2 || (!single && !s.calib)) {
      s.calib = calibration;
      s.calibName = typeof raw.calibrationName === "string" ? raw.calibrationName : "";
      const sizes = Stereo.imageSizes(calibration);
      s.configs = sizes.map((size, i) => {
        const defaults = profile(size);
        const config = {...defaults, ...raw.calibrationImages?.[i]};
        config.width ??= defaults.width;
        config.height ??= defaults.height;
        if (size[0] != null)
          [config.width, config.height] = size;
        return config;
      });
      s.unit = typeof raw.coordinates?.unit === "string" ? raw.coordinates.unit :
          typeof calibration?.unit === "string"          ? calibration.unit :
                                                           "";
    }
    s.id = clamp(int(raw.currentId, 0), 0, s.names.length - 1);
    s.active = single ? slots[0] : clamp(int(raw.currentVideoIndex, 0), 0, 1);
    s.frameStep = int(raw.frameStep, 1, 1);
    s.advance = ["frame", "id"].includes(raw.autoAdvance) ? raw.autoAdvance : "none";
    s.trail = int(raw.trailFrames, 5);
    s.gamma = clamp(number(raw.gamma, 1), 0.1, 2);
    if (!single)
      restoreDisplay(raw.display || {});
    history.length = 0;
    future.length = 0;
    s.dirty = recovery || single;
    pendingAnnotation = null;
    configure();
    selectors();
    syncSettings();
    go(clamp(int(raw.currentFrame, 0), 0, count() - 1));
    schedule();
    queueBackup();
    message(recovery ? "自動保存を復元しました" : "打点を読み込みました");
    return true;
  }
  function backups() {
    const result = [];
    for (const key of [backupKey, oldKey]) {
      try {
        const value = localStorage.getItem(key);
        if (value)
          result.push(JSON.parse(value));
      } catch {
      }
    }
    return result;
  }
  function availableBackup(match) {
    return backups().find(b => {
      if (!match)
        return true;
      try {
        validateSources(b);
        return true;
      } catch {
        return false;
      }
    });
  }
  function saveBackup() {
    clearTimeout(autosaveTimer);
    if (!count() || drag || busyPair)
      return;
    try {
      localStorage.setItem(backupKey, JSON.stringify(payload()));
      backupError = "";
    } catch {
      backupError = "自動保存できません。JSONを保存してください";
      refresh();
    }
  }
  function queueBackup() {
    clearTimeout(autosaveTimer);
    if (count())
      autosaveTimer = setTimeout(saveBackup, 750);
  }
  function changed() {
    if (count())
      s.dirty = true;
    queueBackup();
    schedule();
  }
  function saveDisk() {
    if (!count())
      return;
    finishDrag(true);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload())], {type: "application/json"})),
          link = document.createElement("a");
    link.href = url;
    link.download = s.videos[0].name.replace(/\.[^.]+$/, "") + "-stereo-" +
        new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    s.dirty = false;
    saveBackup();
    refresh();
  }
  function message(text) {
    $("message").textContent = text;
  }
  function openSettings() {
    finishDrag(true);
    syncSettings();
    if (!$("dialog").open)
      $("dialog").showModal();
  }
  function buildSettings() {
    for (let c = 0; c < 2; c++) {
      const slot = document.createElement("div");
      slot.className = "row";
      slot.innerHTML = "<b>Camera " + (c + 1) +
          "</b><span class=\"slotname\"></span><label class=\"filebutton\">MP4を選ぶ<input type=\"file\" accept=\".mp4,video/mp4\" id=\"file" +
          c + "\"></label>";
      $("fileSlots").append(slot);
      $("file" + c).onchange = e => {
        if (e.target.files[0])
          staged[c] = e.target.files[0];
        e.target.value = "";
        updateSlots();
        message("");
      };
      const group = document.createElement("fieldset");
      group.innerHTML = "<legend>Camera " + (c + 1) +
          " <small class=\"actual\"></small></legend><div class=\"geom-fields\"><label>キャリブ幅 <input type=\"number\" min=\"1\" data-key=\"width\"></label><label>高さ <input type=\"number\" min=\"1\" data-key=\"height\"></label></div><label class=\"row\">動画 → キャリブ座標 <select data-key=\"mode\"><option value=\"identity\">同じ画素座標</option><option value=\"affine\">確認済みの倍率・移動</option></select></label><div class=\"affine\" hidden><small>u = sx × x + ox　／　v = sy × y + oy</small><div class=\"geom-fields\">" +
          ["sx", "sy", "ox", "oy"]
              .map(
                  k => "<label>" + k + " <input type=\"number\" step=\"any\" data-key=\"" + k +
                      "\"></label>")
              .join("") +
          "</div></div>";
      group.querySelector("select").onchange = e => group.querySelector(".affine").hidden =
          e.target.value !== "affine";
      $("geometry").append(group);
    }
  }
  function updateSlots() {
    document.querySelectorAll(".slotname")
        .forEach((el, c) => {
          const selected = staged[c]?.name || (!pendingAnnotation && s.videos[c]?.name);
          const expected = pendingAnnotation?.videos[c]?.name;
          el.textContent = selected || (expected ? "要選択：" + expected : "未選択");
          if (selected && expected && selected !== expected) el.textContent += "（保存時：" + expected + "）";
        });
    $("pendingProject").hidden = !pendingAnnotation;
    $("pendingInfo").textContent = pendingAnnotation ?
        "動画選択後に打点JSONを復元します。" + (pendingAnnotation.calibration ?
            "キャリブレーションはJSON内のデータを使用します。" : "") : "";
  }
  function syncSettings() {
    updateSlots();
    $("calibName").textContent = s.calibName || (s.calib ? "保存JSON内" : "未読込");
    $("unit").value = s.unit;
    [...$("geometry").children].forEach((g, c) => {
      const v = s.videos[c];
      g.querySelector(".actual").textContent = v ? "動画 " + v.width + " × " + v.height + " px" : "";
      for (const input of g.querySelectorAll("[data-key]"))
        input.value = s.configs[c][input.dataset.key] ?? "";
      const known = Stereo.imageSizes(s.calib)[c][0] != null;
      for (const input of g.querySelectorAll("[data-key=\"width\"],[data-key=\"height\"]"))
        input.readOnly = known;
      g.querySelector(".affine").hidden = s.configs[c].mode !== "affine";
    });
    for (const [key, value] of Object.entries({
           pointName: s.names[s.id],
           idCount: s.names.length,
           advance: s.advance,
           frameStep: s.frameStep,
           trail: s.trail,
           gamma: s.gamma,
           radius: s.radius,
           split: s.split,
           nudgeStep: s.step
         }))
      $(key).value = value;
    $("otherNames").checked = s.otherNames;
    $("epipolar").checked = s.epipolar;
    const backup = availableBackup(!!count());
    $("restore").disabled = !count() || !backup;
    $("backupInfo").textContent = backup ?
        "自動保存　" + (backup.videos || []).map(v => v.name).join(" ／ ") :
        "対応する自動保存はありません";
    layout();
  }
  function layout() {
    $("workspace").style.setProperty("--image-fr", s.split + "fr");
    $("workspace").style.setProperty("--plot-fr", (100 - s.split) + "fr");
  }
  function refresh() {
    const n = count(), editable = s.ready && !busyPair;
    $("loadPair").disabled = busyPair;
    $("done").disabled = busyPair;
    $("loadInputs").inert = busyPair;
    $("cancelLoad").hidden = !busyPair;
    $("retry").hidden = !frameError;
    $("total").textContent = "/ " + (n || "—");
    $("slider").max = $("frameNo").max = n || 1;
    $("slider").value = s.wanted + 1;
    if (document.activeElement !== $("frameNo") || !s.ready)
      $("frameNo").value = s.frame + 1;
    for (const key of ["prev", "next", "frameNo", "slider", "save", "missing"])
      $(key).disabled = !n || busyPair;
    $("prev").disabled ||= s.wanted === 0;
    $("next").disabled ||= s.wanted === n - 1;
    $("idPrev").disabled = busyPair || s.id === 0;
    $("idNext").disabled = busyPair || s.id === s.names.length - 1;
    $("railId").textContent = "対象 " + (s.id + 1);
    $("railId").title = name(s.id);
    $("undo").disabled = !editable || !history.length;
    $("redo").disabled = !editable || !future.length;
    $("save").textContent = s.dirty ? "保存 •" : "保存";
    $("activeLabel").textContent = "C" + (s.active + 1) + " 微調整";
    $("gamma").value = s.gamma;
    $("gammaValue").textContent = s.gamma.toFixed(2);
    $("gamma").disabled = $("gammaReset").disabled = !n || busyPair;
    const selected = observation(s.active, s.id, s.frame);
    document.querySelectorAll("[data-dx],#deletePoint")
        .forEach(b => b.disabled = !editable || !selected);
    cameras.forEach((cam, c) => {
      const v = s.videos[c];
      cam.panel.classList.toggle("active", c === s.active);
      cam.panel.hidden = c !== s.active;
      $("camera" + c).setAttribute("aria-pressed", c === s.active);
      $("camera" + c).disabled = busyPair;
      cam.panel.querySelector(".filename").textContent = v?.name || "未読込";
      cam.panel.querySelector(".filename").title = v?.name || "";
      cam.panel.querySelector(".empty").hidden = !!v;
    });
    const value = v => v == null ? "—" : Number(v.toPrecision(6)) + " " + (s.unit || "単位未設定");
    $("z").textContent = value(xyz(s.id, s.frame)?.[2]);
    $("dist").textContent = value(dist(s.id, s.frame));
    $("scope").value = s.scope;
    $("scope").options[0].textContent = "前後 " + s.radius + " F";
    const status =
        frameError || backupError || (n && !s.ready ? "F " + (s.wanted + 1) + " 読込中…" : reason());
    $("status").textContent = status;
    $("status").title = status;
  }
  function schedule() {
    if (!drawTicket)
      drawTicket = requestAnimationFrame(() => {
        drawTicket = 0;
        drawImages();
        if (preparePlotRange()) {
          plots.drawSpace();
          plots.drawSeries();
        }
        refresh();
      });
  }
  function preparePlotRange() {
    const [lo, hi] = plots.range(), ref = s.refs[s.id];
    if (!geometry || hi - lo < 512) {
      rangeJob = null;
      return true;
    }
    if (rangeJob?.cache !== xyzCache || rangeJob.id !== s.id || rangeJob.ref !== ref ||
        rangeJob.lo !== lo || rangeJob.hi !== hi) {
      rangeJob = {cache: xyzCache, id: s.id, ref, lo, hi, next: lo};
    }
    const until = performance.now() + 6;
    while (rangeJob.next <= hi) {
      const f = rangeJob.next++;
      xyz(s.id, f);
      if (ref != null)
        dist(s.id, f);
      if (performance.now() > until)
        break;
    }
    if (rangeJob.next > hi)
      return true;
    plots.showProgress(
        "表示範囲を計算中　" + Math.round((rangeJob.next - lo) / (hi - lo + 1) * 100) + "%");
    schedule();
    return false;
  }
  function bindUi() {
    $("settings").onclick = openSettings;
    $("done").onclick = () => $("dialog").close();
    $("dialog").oncancel = e => {
      if (busyPair)
        e.preventDefault();
    };
    $("loadPair").onclick = loadPair;
    $("cancelLoad").onclick = () => {
      loadController?.abort();
      message("読み込みを中止しています…");
    };
    $("cancelPending").onclick = () => {
      pendingAnnotation = null;
      syncSettings();
      message("打点JSONの復元待ちを解除しました");
    };
    $("pairFiles").onchange = async e => {
      const files = [...e.target.files];
      e.target.value = "";
      if (!files.length) return;
      if (files.length !== 2) { message("動画を2本選択してください"); return; }
      if (pendingAnnotation?.videos.length === 2) {
        const expected = pendingAnnotation.videos;
        if (expected[0].name === expected[1].name) {
          message("保存時の動画名が同じです。Camera 1・2 の「MP4を選ぶ」でそれぞれ指定してください");
          return;
        }
        const ordered = expected.map(v => files.find(f => f.name === v.name));
        if (!ordered.every(Boolean) || new Set(ordered).size !== 2) {
          message("保存された動画名に一致する2本を選択してください");
          return;
        }
        staged.splice(0, 2, ...ordered);
      } else staged.splice(0, 2, ...files);
      updateSlots();
      if (pendingAnnotation) await loadPair();
      else message("Camera 1・2 の割り当てを確認して「2本を開く」を押してください");
    };
    $("prev").onclick = () => frameStep(-1);
    $("next").onclick = () => frameStep(1);
    for (const [key, delta] of [["idPrev", -1], ["idNext", 1]])
      $(key).onclick = () => {
        finishDrag(true);
        selectId(clamp(s.id + delta, 0, s.names.length - 1));
        changed();
      };
    for (let c = 0; c < 2; c++)
      $("camera" + c).onclick = () => activate(c);
    $("retry").onclick = () => go(s.wanted);
    $("frameNo").onchange = e => {
      go(Number(e.target.value) - 1);
      e.target.value = s.frame + 1;
    };
    $("slider").oninput = e => go(Number(e.target.value) - 1);
    $("target").onchange = e => {
      finishDrag(true);
      selectId(Number(e.target.value));
      changed();
    };
    $("reference").onchange = e => {
      s.refs[s.id] = e.target.value === "" ? null : Number(e.target.value);
      delete distanceCache[s.id];
      s.axes[3] = null;
      changed();
    };
    $("nudgeStep").onchange = e => {
      s.step = Number(e.target.value);
      changed();
    };
    document.querySelectorAll("[data-dx]")
        .forEach(b => b.onclick = () => changePoint(Number(b.dataset.dx), Number(b.dataset.dy)));
    $("deletePoint").onclick = () => changePoint(0, 0, true);
    $("undo").onclick = () => historyStep(true);
    $("redo").onclick = () => historyStep(false);
    $("save").onclick = saveDisk;
    $("restore").onclick = () => {
      try {
        importData(availableBackup(true), true);
      } catch (e) {
        message(e.message);
      }
    };
    $("annotationFile").onchange = async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file)
        return;
      try {
        await readAnnotation(JSON.parse(await file.text()));
      } catch (err) {
        message(err.message);
      }
    };
    $("calibFile").onchange = async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file)
        return;
      let raw = null, error = "";
      try {
        raw = JSON.parse(await file.text());
      } catch {
        error = "キャリブJSONの構文が不正です";
      }
      s.calib = raw;
      s.calibName = file.name;
      s.unit = typeof raw?.unit === "string" ? raw.unit : "";
      s.configs = Stereo.imageSizes(raw).map(size => profile(size));
      configure(true);
      if (error) {
        geometryError = error;
        $("geometryStatus").textContent = error;
      }
      message(geometryError || "キャリブレーションを読み込みました");
      syncSettings();
      changed();
    };
    $("applyGeometry").onclick = () => {
      s.configs = [...$("geometry").children].map((g, i) => {
        const cfg = {...s.configs[i]};
        for (const el of g.querySelectorAll("[data-key]"))
          cfg[el.dataset.key] = el.tagName === "SELECT" ? el.value :
              el.value === ""                           ? null :
                                                          el.valueAsNumber;
        const size = Stereo.imageSizes(s.calib)[i];
        if (size[0] != null)
          [cfg.width, cfg.height] = size;
        return cfg;
      });
      s.unit = $("unit").value.trim();
      configure(true);
      message(geometryError || "寸法と座標変換を適用しました");
      changed();
    };
    $("idCount").onchange = e => {
      const n = int(e.target.valueAsNumber, s.names.length, 1);
      if (n < s.names.length &&
          !confirm("ID " + (n + 1) + " 以降の打点・名称・参照設定を削除しますか？")) {
        e.target.value = s.names.length;
        return;
      }
      resizeIds(n);
      history.length = future.length = 0;
      configure();
      selectors();
      changed();
    };
    $("pointName").onchange = e => {
      s.names[s.id] = e.target.value.trim();
      selectors();
      changed();
    };
    $("advance").onchange = e => {
      s.advance = e.target.value;
      changed();
    };
    for (const [key, min] of [["frameStep", 1], ["trail", 0], ["radius", 1]])
      $(key).onchange = e => {
        s[key] = int(e.target.valueAsNumber, s[key], min);
        e.target.value = s[key];
        changed();
      };
    $("split").oninput = e => {
      s.split = Number(e.target.value);
      layout();
      changed();
    };
    function setGamma(value) {
      s.gamma = clamp(number(value, 1), 0.1, 2);
      changed();
    }
    $("gamma").oninput = e => setGamma(e.target.valueAsNumber);
    $("gammaReset").onclick = () => setGamma(1);
    $("otherNames").onchange = e => {
      s.otherNames = e.target.checked;
      changed();
    };
    $("epipolar").onchange = e => {
      s.epipolar = e.target.checked;
      changed();
    };
    $("scope").onchange = e => {
      s.scope = e.target.value;
      changed();
    };
    $("fitAxes").onclick = () => {
      s.axes = [];
      changed();
    };
    $("fit3d").onclick = () => {
      if (!rangeJob || rangeJob.next > rangeJob.hi)
        plots.fitSpace();
      changed();
    };
    document.querySelectorAll("[data-plane]").forEach(b => b.onclick = () => {
      [s.view3.yaw, s.view3.pitch] =
          ({XY: [0, 0], XZ: [0, Math.PI / 2], YZ: [Math.PI / 2, 0]})[b.dataset.plane];
      changed();
    });
    $("missing").onclick = () => {
      for (let k = 1; k <= count(); k++) {
        const f = (s.frame + k) % count();
        if (!observation(s.active, s.id, f)) {
          $("dialog").close();
          go(f);
          return;
        }
      }
      message("選択カメラ・IDは全フレーム入力済みです");
    };
    window.addEventListener("keydown", e => {
      if ($("dialog").open || !count())
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveDisk();
        return;
      }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        historyStep(!e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        historyStep(false);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        frameStep(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        selectId(clamp(s.id + (e.key === "ArrowUp" ? -1 : 1), 0, s.names.length - 1));
        changed();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        changePoint(0, 0, true);
      }
    });
    const resize = new ResizeObserver(schedule);
    document.querySelectorAll(".viewport").forEach(el => resize.observe(el));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        finishDrag(true);
        saveBackup();
      }
    });
    window.addEventListener("pagehide", () => {
      finishDrag(true);
      saveBackup();
    });
  }
  [0, 1].forEach(bindCamera);
  buildSettings();
  bindUi();
  selectors();
  configure();
  syncSettings();
  refresh();
  schedule();
})();
