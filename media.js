/* Local, non-fragmented 30 fps MP4s written by movieConverter.py. Skip mdat without reading it. */
const StereoMedia = (() => {
  const FPS = 30;
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
      const n = view.getUint32(box.start + 4);
      if (box.end - box.start !== 8 + 8 * n)
        throw Error("MP4 時間情報が不正です");
      for (let i = 0; i < n; i++) {
        const p = box.start + 8 + 8 * i;
        fn(view.getUint32(p), signed ? view.getInt32(p + 4) : view.getUint32(p + 4));
      }
    }
    let samples = 0;
    runs(timing, false, (n, delta) => {
      if (!clock || delta * FPS !== clock)
        throw Error("movieConverter の固定 30 fps MP4 が必要です");
      samples += n;
    });
    if (!count || samples !== count)
      throw Error("サンプル数と時間情報が一致しません");
    // Verify the movie origin and a contiguous presentation grid, including B frames.
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
      const used = new Uint8Array(count);
      let i = 0;
      runs(composition, view.getUint8(composition.start) === 1, (n, offset) => {
        const shift = (offset - origin) * FPS / clock;
        if (!Number.isInteger(shift) || i + n > count)
          throw Error("提示時刻が 30 fps の格子と一致しません");
        for (let j = 0; j < n; j++, i++) {
          const frame = i + shift;
          if (frame < 0 || frame >= count || used[frame])
            throw Error("映像フレームに欠落または重複があります");
          used[frame] = 1;
        }
      });
      if (i !== count)
        throw Error("提示サンプル数が不正です");
    } else if (origin !== 0)
      throw Error("映像の開始フレームを確定できません");
    return count;
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
    let callback, waiter, disposed = false, lastPresented = -1, failedIndex = null;
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
      const number = metadata.mediaTime * FPS, index = Math.round(number);
      lastPresented = Math.abs(number - index) < 0.02 ? index : -1;
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
      const target = (index + 0.5) / FPS;
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
          if (lastPresented !== index || element.seeking || element.readyState < 2 ||
              Math.floor(element.currentTime * FPS) !== index)
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
        if (lastPresented === index && !element.seeking &&
            Math.floor(element.currentTime * FPS) === index) {
          check();
          if (!waiter)
            return;
        }
        element.currentTime = target;
      });
    }
    try {
      [video.frameCount, video.contentTag] =
          await Promise.all([inspect(file), contentTag(file, fullTag)]);
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
          Math.abs(video.duration * FPS - video.frameCount) > 0.1) {
        throw Error("実際の再生区間・画像寸法と映像サンプルが一致しません");
      }
      return video;
    } catch (e) {
      close();
      throw Error(file.name + "：" + e.message);
    }
  }
  return {open, inspect, FPS};
})();
