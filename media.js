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
  // File providers can stall on a cloud-only file. Every range read can be cancelled or timed out.
  function read(file, start, end, signal) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const fail = error => {
        cleanup();
        reader.onload = reader.onerror = null;
        if (reader.readyState === FileReader.LOADING) reader.abort();
        reject(error);
      };
      const cancel = () => fail(Error("読み込みを中止しました"));
      const timer = setTimeout(() => fail(Error(
          "ファイルの読み取りがタイムアウトしました。ファイルを端末にダウンロードして再選択してください")), 15000);
      reader.onload = () => { cleanup(); resolve(reader.result); };
      reader.onerror = () => fail(Error("ファイルを読み取れません。端末へのダウンロードを確認してください"));
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) cancel();
      else reader.readAsArrayBuffer(file.slice(start, end));
    });
  }
  async function inspect(file, signal) {
    // Walk box headers in the file itself. Do not read mdat or the large sample-size/offset tables.
    const lists = new Map();
    async function children(parent) {
      if (!parent) return [];
      if (lists.has(parent.start)) return lists.get(parent.start);
      const list = [];
      for (let p = parent.start; p < parent.end;) {
        const head = new DataView(await read(file, p, Math.min(p + 16, parent.end), signal));
        if (head.byteLength < 8) throw Error("MP4 box ヘッダーが不正です");
        const b = atom(head, 0, parent.end - p);
        list.push({type: b.type, start: p + b.start, end: p + b.end});
        p += b.end;
      }
      lists.set(parent.start, list);
      return list;
    }
    const child = async (box, type) => (await children(box)).find(b => b.type === type);
    const data = async (box, length) => {
      if (!box) throw Error("必要なMP4情報がありません");
      return new DataView(await read(file, box.start, Math.min(box.end, box.start + (length ?? Infinity)), signal));
    };
    const root = await child({start: 0, end: file.size}, "moov");
    if (!root)
      throw Error("moov がなく、総フレーム数を確認できません");
    const tracks = [];
    for (const trak of (await children(root)).filter(b => b.type === "trak")) {
      const handler = await data(await child(await child(trak, "mdia"), "hdlr"), 12);
      if (fourcc(handler, 8) === "vide") tracks.push(trak);
    }
    if (tracks.length !== 1 || await child(root, "mvex"))
      throw Error("単一の映像トラックのサンプル数を確定できません");
    const mdia = await child(tracks[0], "mdia"), stbl = await child(await child(mdia, "minf"), "stbl");
    const sizes = await child(stbl, "stsz") || await child(stbl, "stz2");
    if (!sizes || sizes.end - sizes.start < 12)
      throw Error("映像サンプル数がありません");
    const count = (await data(sizes, 12)).getUint32(8);
    const mdhd = await data(await child(mdia, "mdhd"), 32),
          clock = mdhd.getUint32(mdhd.getUint8(0) ? 20 : 12);
    const timing = await data(await child(stbl, "stts"));
    function runs(view, signed, fn) {
      if (view.byteLength < 8)
        throw Error("MP4 時間情報がありません");
      const n = view.getUint32(4);
      if (view.byteLength !== 8 + 8 * n)
        throw Error("MP4 時間情報が不正です");
      for (let i = 0; i < n; i++) {
        const p = 8 + 8 * i;
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
    const edits = await child(tracks[0], "edts"), list = await child(edits, "elst");
    let origin = 0;
    if (list) {
      const view = await data(list), wide = view.getUint8(0) === 1;
      origin = wide ? Number(view.getBigInt64(16)) : view.getInt32(12);
      if (view.getUint32(4) !== 1 || origin < 0 ||
          view.getInt32(wide ? 24 : 16) !== 65536)
        throw Error("編集された動画時間軸には対応していません");
    }
    const compositionBox = await child(stbl, "ctts");
    if (compositionBox) {
      const composition = await data(compositionBox);
      let i = 0;
      runs(composition, composition.getUint8(0) === 1, (n, offset) => {
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
  async function contentTag(file, signal) {
    let crc = 0xffffffff;
    async function add(start, length) {
      const bytes = new Uint8Array(await read(file, start, Math.min(start + length, file.size), signal));
      for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
    }
    const length = 16384;
    for (const start of [0, Math.floor(file.size / 2), Math.max(0, file.size - length)])
      await add(start, length);
    return ["sample-crc32", file.size, ((crc ^ 0xffffffff) >>> 0).toString(16)].join(
        "-");
  }
  async function open(file, {signal, onProgress = () => {}} = {}) {
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, {once: true});
    if (signal?.aborted) cancel();
    const element = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    element.preload = "metadata";
    let callback, waiter, timeline, disposed = false, lastPresented = null, failedIndex = null,
        presentationSerial = 0;
    const cache = new Map();
    const video = {name: file.name, element, frame, close};
    function close() {
      if (disposed) return;
      disposed = true;
      signal?.removeEventListener("abort", cancel);
      controller.abort();
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
      presentationSerial++;
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
        let settled = false, seekComplete = false, paint = 0;
        const initialSerial = presentationSerial;
        const timer = setTimeout(
            () => fail(Error(
                video.name + "：フレーム " + (index + 1) +
                " の描画を確認できません。再試行してください")),
            3500);
        function cleanup() {
          settled = true;
          clearTimeout(timer);
          cancelAnimationFrame(paint);
          element.removeEventListener("seeked", seeked);
          element.removeEventListener("error", onError);
          controller.signal.removeEventListener("abort", aborted);
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
        function aborted() { fail(Error("読み込みを中止しました")); }
        function seeked() {
          seekComplete = true;
          // Paused/occluded videos may not reach the compositor. A completed seek with current
          // decoded data is sufficient for drawImage; allow pending presentation callbacks first.
          paint = requestAnimationFrame(() => {
            paint = requestAnimationFrame(() => check(true));
          });
          check();
        }
        function check(allowDecoded = false) {
          if (settled || element.seeking || element.readyState < 2 ||
              element.currentTime < start || element.currentTime >= end)
            return;
          const confirmed = Number.isFinite(lastPresented) && Math.abs(lastPresented - start) <= tolerance;
          // An explicit contradictory presentation must still block edits and trigger retry.
          if (!confirmed && !(allowDecoded && seekComplete && presentationSerial === initialSerial))
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
        element.addEventListener("seeked", seeked);
        element.addEventListener("error", onError);
        controller.signal.addEventListener("abort", aborted, {once: true});
        if (controller.signal.aborted) { aborted(); return; }
        check();
        if (!waiter)
          return;
        element.currentTime = target;
      });
    }
    try {
      document.getElementById("videoPool").append(element);
      if (element.requestVideoFrameCallback)
        callback = element.requestVideoFrameCallback(presented);
      video.url = URL.createObjectURL(file);
      const phases = ["フレーム情報を確認中", "ファイル識別中", "再生準備中"];
      const progress = () => onProgress(phases.filter(Boolean).join(" / ") || "映像情報を確認済み");
      progress();
      const metadata = new Promise((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          element.onloadedmetadata = null;
          element.onerror = null;
          controller.signal.removeEventListener("abort", abort);
        };
        const abort = () => { stop(); reject(Error("読み込みを中止しました")); };
        const timer = setTimeout(() => {
          stop();
          reject(Error("再生準備がタイムアウトしました。動画を端末にダウンロードして再選択してください"));
        }, 15000);
        element.onloadedmetadata = () => {
          stop();
          resolve();
        };
        element.onerror = () => {
          stop();
          reject(Error("このブラウザで再生できません"));
        };
        controller.signal.addEventListener("abort", abort, {once: true});
        if (controller.signal.aborted) { abort(); return; }
        element.src = video.url;
      });
      const results = await Promise.all([
        inspect(file, controller.signal), contentTag(file, controller.signal), metadata
      ].map((promise, i) => promise.then(value => { phases[i] = ""; progress(); return value; })));
      [timeline, video.contentTag] = results;
      video.frameCount = timeline.frameCount;
      video.fps = timeline.fps;
      video.variableFrameRate = timeline.variableFrameRate;
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
