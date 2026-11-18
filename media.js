/* Read frame counts and presentation times from local MP4 sample tables. Skip mdat data. */
const StereoMedia = (() => {
  const fourcc = (dv, p) => String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + p, 4));
  function atom(view, offset, end) {
    let size = view.getUint32(offset), header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size === 0)
      size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || size > end - offset)
      throw Error("MP4 box 長が不正です");
    return {type: fourcc(view, offset + 4), start: offset + header, end: offset + size};
  }
  async function inspect(file) {
    let view;
    for (let p = 0; p < file.size;) {
      const head = new DataView(await file.slice(p, p + 16).arrayBuffer());
      const box = atom(head, 0, file.size - p);
      if (box.type === "moov") {
        view = new DataView(await file.slice(p + box.start, p + box.end).arrayBuffer());
        break;
      }
      p += box.end;
    }
    if (!view)
      throw Error("moov がなく、総フレーム数を確認できません");
    function children(parent) {
      const list = [];
      for (let p = parent.start; p < parent.end;) {
        const b = atom(view, p, parent.end);
        list.push(b);
        p = b.end;
      }
      return list;
    }
    const child = (box, type) => children(box).find(b => b.type === type);
    const root = {start: 0, end: view.byteLength};
    const tracks = children(root).filter(b => b.type === "trak").filter(trak => {
      const handler = child(child(trak, "mdia"), "hdlr");
      return fourcc(view, handler.start + 8) === "vide";
    });
    if (tracks.length !== 1 || child(root, "mvex"))
      throw Error("単一の映像トラックのサンプル数を確定できません");
    const mdia = child(tracks[0], "mdia"), stbl = child(child(mdia, "minf"), "stbl");
    const sizes = child(stbl, "stsz") || child(stbl, "stz2");
    if (!sizes || sizes.end - sizes.start < 12)
      throw Error("映像サンプル数がありません");
    const count = view.getUint32(sizes.start + 8);
    const mdhd = child(mdia, "mdhd"),
          clock = view.getUint32(mdhd.start + (view.getUint8(mdhd.start) ? 20 : 12));
    const timing = child(stbl, "stts");
    function runs(box, signed, fn) {
      if (!box || box.end - box.start < 8)
        throw Error("MP4 時間情報がありません");
      const n = view.getUint32(box.start + 4);
      if (box.end - box.start !== 8 + 8 * n)
        throw Error("MP4 時間情報が不正です");
      for (let i = 0; i < n; i++) {
        const p = box.start + 8 + 8 * i;
        fn(view.getUint32(p), signed ? view.getInt32(p + 4) : view.getUint32(p + 4));
      }
    }
    if (!count || !clock)
      throw Error("映像サンプル数または時間単位が不正です");
    const timestamps = new Float64Array(count);
    const durations = new Float64Array(count);
    let samples = 0, decodeTime = 0;
    runs(timing, false, (n, delta) => {
      if (!n || !delta || samples + n > count)
        throw Error("映像サンプルの時間情報が不正です");
      for (let j = 0; j < n; j++, samples++) {
        timestamps[samples] = decodeTime;
        durations[samples] = delta;
        decodeTime += delta;
      }
    });
    if (samples !== count || !Number.isSafeInteger(decodeTime))
      throw Error("サンプル数と時間情報が一致しません");
    // Convert decode order to presentation order, including B frames and variable durations.
    const edits = child(tracks[0], "edts"), list = edits && child(edits, "elst");
    let origin = 0;
    if (list) {
      const wide = view.getUint8(list.start) === 1;
      origin = wide ? Number(view.getBigInt64(list.start + 16)) : view.getInt32(list.start + 12);
      if (view.getUint32(list.start + 4) !== 1 || origin < 0 ||
          view.getInt32(list.start + (wide ? 24 : 16)) !== 65536)
        throw Error("編集された動画時間軸には対応していません");
    }
    const composition = child(stbl, "ctts");
    if (composition) {
      let i = 0;
      runs(composition, view.getUint8(composition.start) === 1, (n, offset) => {
        if (!n || i + n > count)
          throw Error("提示サンプル数が不正です");
        for (let j = 0; j < n; j++, i++)
          timestamps[i] += offset;
      });
      if (i !== count)
        throw Error("提示サンプル数が不正です");
    }
    let lastSample = 0;
    for (let i = 0; i < count; i++) {
      timestamps[i] -= origin;
      if (!Number.isSafeInteger(timestamps[i]) || timestamps[i] < 0)
        throw Error("再生区間外の映像サンプルがあります");
      if (timestamps[i] > timestamps[lastSample])
        lastSample = i;
    }
    const endTicks = timestamps[lastSample] + durations[lastSample];
    timestamps.sort();
    let shortest = endTicks - timestamps[count - 1], longest = shortest;
    for (let i = 1; i < count; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap <= 0)
        throw Error("映像フレームの提示時刻が重複しています");
      shortest = Math.min(shortest, gap);
      longest = Math.max(longest, gap);
    }
    const fps = count * clock / (endTicks - timestamps[0]);
    for (let i = 0; i < count; i++)
      timestamps[i] /= clock;
    return {
      frameCount: count,
      timestamps,
      endTime: endTicks / clock,
      fps,
      variableFrameRate: longest - shortest > 1
    };
  }

  // Distinguish same-named exports in different folders without loading entire movies into RAM.
  const crcTable = Uint32Array.from({length: 256}, (_, i) => {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });
  async function contentTag(file, full) {
    let crc = 0xffffffff;
    async function add(start, length) {
      const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
      for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
    }
    if (full) {
      const chunk = 4 * 1024 * 1024;
      for (let start = 0; start < file.size; start += chunk) await add(start, chunk);
    } else {
      const length = 16384;
      for (const start of [0, Math.floor(file.size / 2), Math.max(0, file.size - length)])
        await add(start, length);
    }
    return [full ? "crc32" : "sample-crc32", file.size, ((crc ^ 0xffffffff) >>> 0).toString(16)].join(
        "-");
  }
  async function open(file, fullTag = false) {
    const element = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    element.preload = "auto";
    let callback, waiter, timeline, disposed = false, lastPresented = null, failedIndex = null;
    const cache = new Map();
    const video = {name: file.name, element, frame, close};
    function close() {
      disposed = true;
      if (callback != null)
        element.cancelVideoFrameCallback(callback);
      waiter?.fail(Error("動画を閉じました"));
      element.removeAttribute("src");
      element.load();
      element.remove();
      if (video.url)
        URL.revokeObjectURL(video.url);
      cache.clear();
    }
    function capture(index) {
      if (cache.has(index))
        return cache.get(index);
      const width = element.videoWidth, height = element.videoHeight;
      const limit = Math.max(2, Math.min(6, Math.floor(24 * 1024 * 1024 / (4 * width * height))));
      let canvas;
      if (cache.size >= limit) {
        // Keep the displayed image intact until both decoders have completed the next request.
        const [oldIndex, reusable] = [...cache].find(([,image]) => image !== video.displayed);
        cache.delete(oldIndex);
        canvas = reusable;
      } else {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext("2d").drawImage(element, 0, 0);
      cache.set(index, canvas);
      return canvas;
    }
    function presented(_, metadata) {
      if (disposed)
        return;
      lastPresented = metadata.mediaTime;
      waiter?.check();
      callback = element.requestVideoFrameCallback(presented);
    }
    function frame(index) {
      if (cache.has(index))
        return Promise.resolve(cache.get(index));
      // A paused video may not submit a new frame when seeking to exactly its current time.
      const retry = failedIndex === index && video.frameCount > 1;
      failedIndex = null;
      if (retry)
        return decode(index === 0 ? 1 : index - 1).then(() => decode(index));
      return decode(index);
    }
    function decode(index) {
      const start = timeline.timestamps[index];
      const end = timeline.timestamps[index + 1] ?? timeline.endTime;
      const target = start + (end - start) / 2;
      const previousGap = index > 0 ? start - timeline.timestamps[index - 1] : end - start;
      // Browser timestamps may be rounded to microseconds. Keep the tolerance below adjacent frames.
      const tolerance = Math.min(0.001, previousGap / 4, (end - start) / 4);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => fail(Error(
                video.name + "：フレーム " + (index + 1) +
                " の描画を確認できません。再試行してください")),
            3500);
        function cleanup() {
          clearTimeout(timer);
          element.removeEventListener("seeked", check);
          element.removeEventListener("error", onError);
          waiter = null;
        }
        function fail(e) {
          failedIndex = index;
          cleanup();
          reject(e);
        }
        function onError() {
          fail(Error(video.name + "：動画のデコードに失敗しました"));
        }
        function check() {
          if (!Number.isFinite(lastPresented) || Math.abs(lastPresented - start) > tolerance ||
              element.seeking || element.readyState < 2 ||
              element.currentTime < start || element.currentTime >= end)
            return;
          try {
            const canvas = capture(index);
            cleanup();
            resolve(canvas);
          } catch (e) {
            fail(e);
          }
        }
        waiter = {check, fail};
        element.addEventListener("seeked", check);
        element.addEventListener("error", onError);
        check();
        if (!waiter)
          return;
        element.currentTime = target;
      });
    }
    try {
      [timeline, video.contentTag] =
          await Promise.all([inspect(file), contentTag(file, fullTag)]);
      video.frameCount = timeline.frameCount;
      video.fps = timeline.fps;
      video.variableFrameRate = timeline.variableFrameRate;
      if (!element.requestVideoFrameCallback)
        throw Error("提示フレームを確認できる Safari / Chrome が必要です");
      document.getElementById("videoPool").append(element);
      callback = element.requestVideoFrameCallback(presented);
      video.url = URL.createObjectURL(file);
      await new Promise((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          element.onloadedmetadata = null;
          element.onerror = null;
        };
        const timer = setTimeout(() => {
          stop();
          reject(Error("動画情報の読み込みがタイムアウトしました"));
        }, 10000);
        element.onloadedmetadata = () => {
          stop();
          resolve();
        };
        element.onerror = () => {
          stop();
          reject(Error("このブラウザで再生できません"));
        };
        element.src = video.url;
      });
      video.width = element.videoWidth;
      video.height = element.videoHeight;
      video.duration = element.duration;
      if (!video.width || !video.height || !Number.isFinite(video.duration) ||
          video.duration <= timeline.timestamps[video.frameCount - 1]) {
        throw Error("実際の再生区間・画像寸法と映像サンプルが一致しません");
      }
      timeline.endTime = Math.min(timeline.endTime, video.duration);
      return video;
    } catch (e) {
      close();
      throw Error(file.name + "：" + e.message);
    }
  }
  return {open, inspect};
})();
