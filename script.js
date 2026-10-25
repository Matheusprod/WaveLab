const $ = id => document.getElementById(id);
    const canvas = $('visual'), ctx = canvas.getContext('2d', {alpha: false}), audio = $('audio');
    let peaks = [], peakRate = 200, duration = 0, raf = 0, bgImage = null, bgVersion = 0, bgCache = null, bgCacheKey = '', objectUrl = null;
    let audioCtx = null, sourceNode = null, recordDest = null, recorder = null, chunks = [], recording = false;
    let audioReady = false;
    // Video formats: canvas size, wave height (relative to canvas height) and preview width on the page.
    const FORMATS = {
      '9x16': {w: 720, h: 1280, label: '9:16', amp: .105, view: 360},
      '4x5': {w: 864, h: 1080, label: '4:5', amp: .13, view: 440},
      '1x1': {w: 1080, h: 1080, label: '1:1', amp: .15, view: 480},
      '16x9': {w: 1280, h: 720, label: '16:9', amp: .2, view: 580}
    };
    let vf = FORMATS['9x16'];
    const FPS = 60; // frame rate of the recorded video

    function fmt(s) {if (!Number.isFinite(s)) s = 0; s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');}
    // Smoothed playback clock: audio.currentTime updates in small jumps, which makes the wave tremble.
    let est = 0, lastFrame = 0;
    function smoothTime() {
      const p = performance.now(), dt = lastFrame ? (p - lastFrame) / 1000 : 0; lastFrame = p;
      const ct = audio.currentTime || 0;
      if (audio.paused || audio.ended) {est = ct; return est;}
      est += dt * audio.playbackRate;
      const err = ct - est;
      if (Math.abs(err) > .25) est = ct; else est += err * .1;
      return est;
    }
    function setStatus(s) {$('status').textContent = s}
    // Instagram-style spinning disc: cover art on a rotating vinyl, with bars around it that react to the beat.
    function drawDisc(w, h, sc, now, color, lw) {
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * .22, maxLen = R * .5;
      const speed = Number($('speed').value), hasAudio = peaks.length > 0 && duration > 0;
      const TAU = Math.PI * 2;
      // soft shadow around the disc (a gradient is much cheaper than shadowBlur on every frame)
      const sg = ctx.createRadialGradient(cx, cy, R * .97, cx, cy, R * 1.1);
      sg.addColorStop(0, 'rgba(0,0,0,.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, R * 1.1, 0, TAU); ctx.fill();
      // progress ring (follows the "Show progress line" checkbox)
      ctx.lineCap = 'round'; ctx.lineWidth = 2 * sc;
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, 0, TAU); ctx.stroke();
      if ($('showPlayhead').checked && hasAudio) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, now / duration)); ctx.stroke();
      }
      // bars: the top is "now", and the sound spreads to both sides like a ripple
      const n = 96, dt = .04 * speed, r0 = R * 1.12;
      ctx.strokeStyle = color; ctx.lineWidth = lw + 2 * sc; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const k = i <= n / 2 ? i : n - i;
        let amp = 0;
        if (hasAudio) {
          const t = now - k * dt;
          const lo = Math.max(0, Math.floor((t - dt / 2) * peakRate)), hi = Math.min(peaks.length - 1, Math.ceil((t + dt / 2) * peakRate));
          for (let j = lo; j <= hi; j++) if (peaks[j] > amp) amp = peaks[j];
        }
        const a = -Math.PI / 2 + i * TAU / n, len = Math.max(2 * sc, amp * maxLen);
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      }
      ctx.stroke();
      // disc (rotates with the audio time, so it stops when you pause)
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(now * (Math.PI / 4) * speed);
      ctx.fillStyle = '#101010'; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      ctx.lineWidth = sc; ctx.strokeStyle = 'rgba(255,255,255,.07)';
      for (let r = R * .5; r < R * .98; r += R * .045) {ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();}
      const lr = R * .42;
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, lr, 0, TAU); ctx.clip();
      if (bgImage) {
        const k2 = Math.max(2 * lr / bgImage.width, 2 * lr / bgImage.height), iw = bgImage.width * k2, ih = bgImage.height * k2;
        ctx.drawImage(bgImage, -iw / 2, -ih / 2, iw, ih);
      } else {
        ctx.fillStyle = color; ctx.fillRect(-lr, -lr, 2 * lr, 2 * lr);
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(lr * .62, 0, lr * .1, 0, TAU); ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.arc(0, 0, lr, 0, TAU); ctx.stroke();
      ctx.fillStyle = $('bgColor').value; ctx.beginPath(); ctx.arc(0, 0, R * .05, 0, TAU); ctx.fill();
      ctx.restore();
      // fixed light reflections and rim, so the rotation feels real
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      [Math.PI * .15, Math.PI * 1.15].forEach(a0 => {ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a0 + Math.PI * .18); ctx.closePath(); ctx.fill();});
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = sc; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    }
    // Blurred full-screen version of the cover (built once and cached, so it doesn't slow down the animation).
    function getBlurredBg(w, h, sc) {
      const key = w + 'x' + h + '|' + bgVersion;
      if (bgCacheKey !== key) {
        bgCache = document.createElement('canvas'); bgCache.width = w; bgCache.height = h;
        const c = bgCache.getContext('2d');
        const k = Math.max(w / bgImage.width, h / bgImage.height) * 1.15, iw = bgImage.width * k, ih = bgImage.height * k;
        c.filter = 'blur(' + Math.round(26 * sc) + 'px)';
        c.drawImage(bgImage, (w - iw) / 2, (h - ih) / 2, iw, ih);
        bgCacheKey = key;
      }
      return bgCache;
    }
    function draw() {
      cancelAnimationFrame(raf);
      const w = canvas.width, h = canvas.height;
      const sc = Math.min(w, h) / 720; // scales line widths and text so every format looks proportional
      const disc = $('waveShape').value === 'disc';
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = $('bgColor').value; ctx.fillRect(0, 0, w, h);
      if (bgImage && disc) {
        // Spinning disc: the cover also fills the background, blurred
        ctx.save(); ctx.globalAlpha = .92; ctx.drawImage(getBlurredBg(w, h, sc), 0, 0); ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, 0, w, h);
      } else if (bgImage) {
        const scale = Math.max(w / bgImage.width, h / bgImage.height), iw = bgImage.width * scale, ih = bgImage.height * scale;
        ctx.save(); ctx.globalAlpha = .32; ctx.drawImage(bgImage, (w - iw) / 2, (h - ih) / 2, iw, ih); ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, w, h);
      }
      const centerY = h * .5, left = w * .09, right = w * .91, plotW = right - left, maxAmp = h * vf.amp;
      const midX = $('showPlayhead').checked ? w * .5 : left;
      const color = $('waveColor').value, lw = Number($('lineWidth').value) * sc;
      // subtle framing line
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
      if (!disc) {ctx.beginPath(); ctx.moveTo(left, centerY); ctx.lineTo(right, centerY); ctx.stroke();}
      if (disc) {
        drawDisc(w, h, sc, smoothTime(), color, lw);
      } else if (peaks.length && duration > 0) {
        const now = smoothTime(), pxPerSec = (plotW / 9) * Number($('speed').value);
        const shape = $('waveShape').value;
        const barW = lw + 2 * sc;
        const step = shape === 'bars' ? barW * 2 : shape === 'dots' ? 8 * sc : 2;
        // Each peak is anchored to its own moment in time, so the wave scrolls smoothly at any speed.
        const pxPerPeak = pxPerSec / peakRate;
        const stride = Math.max(1, Math.round(step / pxPerPeak));
        const tLeft = now + (left - midX) / pxPerSec, tRight = now + (right - midX) / pxPerSec;
        const kFirst = Math.ceil(tLeft * peakRate / stride) * stride, kLast = tRight * peakRate;
        const pts = [];
        for (let k = kFirst; k <= kLast; k += stride) {
          let amp = 0;
          if (k >= 0 && k < peaks.length) {
            let m = 0;
            for (let j = k; j < Math.min(k + stride, peaks.length); j++) if (peaks[j] > m) m = peaks[j];
            amp = m * maxAmp;
          }
          pts.push({x: midX + (k / peakRate - now) * pxPerSec, amp});
        }
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (shape === 'line') {
          [-1, 1].forEach(sign => {
            ctx.beginPath();
            pts.forEach((p, i) => i ? ctx.lineTo(p.x, centerY + sign * p.amp) : ctx.moveTo(p.x, centerY + sign * p.amp));
            ctx.stroke();
          });
        } else if (shape === 'filled') {
          ctx.beginPath();
          pts.forEach((p, i) => i ? ctx.lineTo(p.x, centerY - p.amp) : ctx.moveTo(p.x, centerY - p.amp));
          for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, centerY + pts[i].amp);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        } else if (shape === 'dots') {
          const r = lw + sc;
          pts.forEach(p => {
            ctx.beginPath(); ctx.arc(p.x, centerY - p.amp, r, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(p.x, centerY + p.amp, r, 0, Math.PI * 2); ctx.fill();
          });
        } else {
          // 'classic' (thin mirrored lines) and 'bars' (thicker rounded bars with gaps)
          ctx.lineWidth = shape === 'bars' ? barW : lw;
          ctx.beginPath();
          pts.forEach(p => {
            const a = shape === 'bars' ? Math.max(p.amp, sc) : p.amp;
            ctx.moveTo(p.x, centerY - a); ctx.lineTo(p.x, centerY + a);
          });
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.font = (24 * sc) + 'px system-ui'; ctx.textAlign = 'center';
        ctx.fillText('IMPORT YOUR BEAT', w / 2, centerY + 8);
      }
      if ($('showPlayhead').checked && !disc) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2 * sc;
        ctx.beginPath(); ctx.moveTo(midX, centerY - maxAmp * 1.43); ctx.lineTo(midX, centerY + maxAmp * 1.43); ctx.stroke();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(midX, centerY, 5 * sc, 0, Math.PI * 2); ctx.fill();
      }
      if ($('showText').checked) {
        const title = $('title').value.trim();
        ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.88)';
        ctx.font = '600 ' + (22 * sc) + 'px system-ui'; ctx.letterSpacing = (4 * sc) + 'px';
        ctx.fillText(title || ' ', w / 2, h * .12, w * .82);
                ctx.letterSpacing = '0px';
      }
      $('time').textContent = fmt(audio.currentTime) + ' / ' + fmt(duration);
      $('bar').style.width = (duration ? 100 * audio.currentTime / duration : 0) + '%';
      $('previewLabel').textContent = audioReady ? (recording ? 'Recording…' : 'Animated waveform') : 'Waiting for audio';
      raf = requestAnimationFrame(draw);
    }
    function makePeaks(buffer) {
      const data = buffer.getChannelData(0), block = Math.max(1, Math.floor(buffer.sampleRate / 200));
      peakRate = buffer.sampleRate / block;
      const result = [];
      for (let i = 0; i < data.length; i += block) {let max = 0; for (let j = i; j < Math.min(i + block, data.length); j++)max = Math.max(max, Math.abs(data[j])); result.push(max);}
      return result;
    }
    async function setupAudioGraph() {
      // The recorder captures the audio element directly, avoiding a silent WebAudio destination.
      if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    }
    $('audioFile').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file); audio.src = objectUrl; audio.load();
      $('audioName').textContent = file.name; setStatus('Rendering audio and calculating waveform…');
      try {
        const ab = await file.arrayBuffer();
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await ac.decodeAudioData(ab.slice(0)); peaks = makePeaks(buffer); duration = buffer.duration; await ac.close();
        audioReady = true; $('play').disabled = false; $('restart').disabled = false; $('export').disabled = false;
        $('play').textContent = '▶ Play'; setStatus('Ready! Press "Play".');
      } catch (err) {setStatus('Cannot read this audio. Try export in MP3 or WAV.'); console.error(err)}
    });
    $('bgFile').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {bgImage = img; bgVersion++; URL.revokeObjectURL(url);}; img.src = url;
    });
    $('clearBg').addEventListener('click', () => {bgImage = null; bgVersion++; $('bgFile').value = '';});
    $('play').addEventListener('click', async () => {
      if (!audioReady) return;
      await setupAudioGraph();
      if (audio.paused) {try {await audio.play(); $('play').textContent = 'Ⅱ Pausar';} catch (e) {setStatus('Click Play again to start audio.');} }
      else {audio.pause(); $('play').textContent = '▶ Play';}
    });
    audio.addEventListener('ended', () => {$('play').textContent = '▶ Play'; if (recording) stopRecording();});
    audio.addEventListener('pause', () => {if (!recording) $('play').textContent = '▶ Play';});
    $('restart').addEventListener('click', () => {audio.currentTime = 0; if (audioReady) {audio.pause(); $('play').textContent = '▶ Play';} });
    $('lineWidth').addEventListener('input', () => $('widthValue').textContent = $('lineWidth').value + ' px');
    $('speed').addEventListener('input', () => $('speedValue').textContent = $('speed').value + '×');
    ['waveColor', 'bgColor', 'lineWidth', 'speed', 'title', 'showPlayhead', 'showText', 'waveShape'].forEach(id => $(id).addEventListener('input', () => { }));

    let lastVideoBlob = null;
    let lastVideoUrl = null;
    let lastVideoName = 'wavelab-beat.webm';

    // ---- MP4 FIX START ----
    // MediaRecorder writes a "fragmented" MP4 (the header has no total duration). Some phones and apps read that wrong
    // (for example, showing only a couple of seconds). This rewrites it as a regular MP4 with the full duration and the
    // audio/video in sync. It only moves the data around: no re-encoding, so no quality loss.
    function fixMp4(input) {
      const src = input instanceof Uint8Array ? input : new Uint8Array(input);
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const u32 = o => dv.getUint32(o), i32 = o => dv.getInt32(o);
      const u64 = o => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);
      const fourcc = o => String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
      const str = s => Array.from(s, c => c.charCodeAt(0));
      const u32s = ns => {const o = new Uint8Array(ns.length * 4), d = new DataView(o.buffer); ns.forEach((n, i) => d.setUint32(i * 4, n >>> 0)); return o;};
      const box = (type, ...parts) => {
        let len = 8; parts.forEach(p => len += p.length);
        const out = new Uint8Array(len); out.set(u32s([len]), 0); out.set(str(type), 4);
        let o = 8; parts.forEach(p => {out.set(p, o); o += p.length;});
        return out;
      };
      const fullBox = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
      const boxes = (start, end) => {
        const out = []; let o = start;
        while (o + 8 <= end) {
          let size = u32(o), hdr = 8;
          const type = fourcc(o + 4);
          if (size === 1) {size = u64(o + 8); hdr = 16;} else if (size === 0) size = end - o;
          if (size < hdr || o + size > end) break;
          out.push({type, start: o, hdr, end: o + size, body: o + hdr});
          o += size;
        }
        return out;
      };
      const find = (list, t) => list.find(b => b.type === t);
      const raw = b => src.subarray(b.start, b.end);

      const top = boxes(0, src.length);
      const moov = find(top, 'moov');
      if (!moov) throw new Error('moov not found');
      const moovKids = boxes(moov.body, moov.end);
      const mvex = find(moovKids, 'mvex');
      if (!mvex || !top.some(b => b.type === 'moof')) return null; // already a regular MP4

      // --- tracks ---
      const tracks = {}, order = [];
      for (const trak of moovKids.filter(b => b.type === 'trak')) {
        const k = boxes(trak.body, trak.end);
        const tkhd = find(k, 'tkhd'), mdia = find(k, 'mdia');
        const id = u32(tkhd.body + (src[tkhd.body] === 1 ? 20 : 12));
        const mk = boxes(mdia.body, mdia.end);
        const mdhd = find(mk, 'mdhd'), hdlr = find(mk, 'hdlr'), minf = find(mk, 'minf');
        const mi = boxes(minf.body, minf.end);
        const stbl = find(mi, 'stbl');
        tracks[id] = {
          id, width: u32(tkhd.end - 8), height: u32(tkhd.end - 4),
          timescale: u32(mdhd.body + (src[mdhd.body] === 1 ? 20 : 12)), lang: dv.getUint16(mdhd.end - 4),
          handler: fourcc(hdlr.body + 8), hdlr: raw(hdlr), mediaHdr: find(mi, 'vmhd') || find(mi, 'smhd'), dinf: find(mi, 'dinf'),
          stsd: find(boxes(stbl.body, stbl.end), 'stsd'),
          trex: {dur: 0, size: 0, flags: 0}, samples: [], start: 0, end: 0
        };
        order.push(id);
      }
      if (!order.length) throw new Error('no tracks');
      for (const trex of boxes(mvex.body, mvex.end).filter(b => b.type === 'trex')) {
        const t = tracks[u32(trex.body + 4)];
        if (t) t.trex = {dur: u32(trex.body + 12), size: u32(trex.body + 16), flags: u32(trex.body + 20)};
      }

      // --- fragments ---
      for (const moof of top.filter(b => b.type === 'moof')) {
        let prevEnd = moof.start;
        for (const traf of boxes(moof.body, moof.end).filter(b => b.type === 'traf')) {
          const tk = boxes(traf.body, traf.end);
          const tfhd = find(tk, 'tfhd'), fl = u32(tfhd.body) & 0xffffff;
          let o = tfhd.body + 4;
          const t = tracks[u32(o)]; o += 4;
          let base = null, defDur = t ? t.trex.dur : 0, defSize = t ? t.trex.size : 0, defFlags = t ? t.trex.flags : 0;
          if (fl & 1) {base = u64(o); o += 8;}
          if (fl & 2) o += 4;
          if (fl & 8) {defDur = u32(o); o += 4;}
          if (fl & 0x10) {defSize = u32(o); o += 4;}
          if (fl & 0x20) {defFlags = u32(o); o += 4;}
          if (base === null) base = (fl & 0x20000) ? moof.start : prevEnd;
          if (!t) continue;
          const tfdt = find(tk, 'tfdt');
          if (tfdt) {
            const val = src[tfdt.body] === 1 ? u64(tfdt.body + 4) : u32(tfdt.body + 4);
            if (!t.samples.length) {t.start = val; t.end = val;}
            else if (val !== t.end) { // keep the timeline exactly as recorded
              const last = t.samples[t.samples.length - 1], nd = Math.max(1, last.dur + (val - t.end));
              t.end += nd - last.dur; last.dur = nd;
            }
          }
          let ptr = null;
          for (const trun of tk.filter(b => b.type === 'trun')) {
            const ver = src[trun.body], f = u32(trun.body) & 0xffffff;
            let p = trun.body + 4;
            const count = u32(p); p += 4;
            let off = ptr;
            if (f & 1) {off = base + i32(p); p += 4;} else if (off === null) off = base;
            let firstFlags = null;
            if (f & 4) {firstFlags = u32(p); p += 4;}
            for (let i = 0; i < count; i++) {
              let dur = defDur, size = defSize, sf = defFlags, cto = 0;
              if (f & 0x100) {dur = u32(p); p += 4;}
              if (f & 0x200) {size = u32(p); p += 4;}
              if (f & 0x400) {sf = u32(p); p += 4;} else if (i === 0 && firstFlags !== null) sf = firstFlags;
              if (f & 0x800) {cto = ver === 1 ? i32(p) : u32(p); p += 4;}
              t.samples.push({off, size, dur, cto, sync: (sf & 0x10000) === 0});
              t.end += dur; off += size;
            }
            ptr = off;
          }
          if (ptr !== null) prevEnd = ptr;
        }
      }
      order.forEach(id => {
        const t = tracks[id];
        if (!t.samples.length) throw new Error('track without samples');
        t.samples.forEach(s => {if (s.off + s.size > src.length) throw new Error('truncated data');});
      });

      // --- chunks (about 1 s each), interleaved by time so players can stream/seek ---
      const chunks = [];
      order.forEach(id => {
        const t = tracks[id]; let dts = 0, cur = null;
        t.chunks = [];
        t.samples.forEach((s, i) => {
          if (!cur || dts - cur.t0 >= t.timescale) {
            cur = {t, first: i, count: 0, size: 0, t0: dts, sec: (t.start + dts) / t.timescale};
            t.chunks.push(cur); chunks.push(cur);
          }
          cur.count++; cur.size += s.size; dts += s.dur;
        });
      });
      const orderIdx = id => order.indexOf(id);
      chunks.sort((a, b) => a.sec - b.sec || orderIdx(a.t.id) - orderIdx(b.t.id));
      let mdatLen = 0;
      chunks.forEach(c => {c.mdatOff = mdatLen; mdatLen += c.size;});
      if (mdatLen + 8 > 4294967295) throw new Error('file too large');

      // --- timing per track ---
      const MOVIE_TS = 1000;
      const minStart = Math.min(...order.map(id => tracks[id].start / tracks[id].timescale));
      let movieDur = 0;
      order.forEach(id => {
        const t = tracks[id];
        t.mediaDur = t.samples.reduce((a, s) => a + s.dur, 0);
        // If the first picture is shown after its decode time (B-frames), start playback at that picture, like regular MP4s do.
        let dts0 = 0, minPts = Infinity;
        t.samples.forEach(s => {minPts = Math.min(minPts, dts0 + s.cto); dts0 += s.dur;});
        t.mediaTime = Math.max(0, minPts);
        t.emptyDur = Math.round((t.start / t.timescale - minStart) * MOVIE_TS);
        t.segDur = Math.max(1, Math.round(t.mediaDur / t.timescale * MOVIE_TS));
        t.movieDur = t.emptyDur + t.segDur;
        movieDur = Math.max(movieDur, t.movieDur);
      });

      const MATRIX = u32s([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);
      const runs = (list) => { // run-length encode a list of numbers into [count, value, ...]
        const out = [];
        list.forEach(v => {if (out.length && out[out.length - 1] === v) out[out.length - 2]++; else out.push(1, v);});
        return out;
      };

      const buildTrak = (t, mdatBase) => {
        const isAudio = t.handler === 'soun', isVideo = t.handler === 'vide';
        const n = t.samples.length;
        const stts = fullBox('stts', 0, 0, u32s([runs(t.samples.map(s => s.dur)).length / 2]), u32s(runs(t.samples.map(s => s.dur))));
        const cttsList = t.samples.map(s => s.cto | 0), hasCto = cttsList.some(v => v !== 0);
        const ctts = hasCto ? fullBox('ctts', cttsList.some(v => v < 0) ? 1 : 0, 0, u32s([runs(cttsList).length / 2]), u32s(runs(cttsList))) : null;
        const syncIdx = []; t.samples.forEach((s, i) => {if (s.sync) syncIdx.push(i + 1);});
        const stss = isVideo && syncIdx.length < n ? fullBox('stss', 0, 0, u32s([syncIdx.length]), u32s(syncIdx)) : null;
        const stscEntries = []; let prev = -1;
        t.chunks.forEach((c, i) => {if (c.count !== prev) {stscEntries.push(i + 1, c.count, 1); prev = c.count;}});
        const stsc = fullBox('stsc', 0, 0, u32s([stscEntries.length / 3]), u32s(stscEntries));
        const stsz = fullBox('stsz', 0, 0, u32s([0, n]), u32s(t.samples.map(s => s.size)));
        const stco = fullBox('stco', 0, 0, u32s([t.chunks.length]), u32s(t.chunks.map(c => mdatBase + c.mdatOff)));
        const stbl = box('stbl', raw(t.stsd), stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, stco);
        const mediaHdr = t.mediaHdr ? raw(t.mediaHdr) : (isAudio ? fullBox('smhd', 0, 0, [0, 0, 0, 0]) : fullBox('vmhd', 0, 1, [0, 0, 0, 0, 0, 0, 0, 0]));
        const dinf = t.dinf ? raw(t.dinf) : box('dinf', fullBox('dref', 0, 0, u32s([1]), fullBox('url ', 0, 1)));
        const minf = box('minf', mediaHdr, dinf, stbl);
        const mdhd = fullBox('mdhd', 0, 0, u32s([0, 0, t.timescale, t.mediaDur]), [t.lang >> 8, t.lang & 255], [0, 0]);
        const mdia = box('mdia', mdhd, t.hdlr, minf);
        const tkhd = fullBox('tkhd', 0, 7, u32s([0, 0, t.id, 0, t.movieDur, 0, 0, 0, isAudio ? 0x01000000 : 0]), MATRIX, u32s([t.width, t.height]));
        const elstEntries = [];
        if (t.emptyDur > 0) elstEntries.push(t.emptyDur, 0xffffffff, 0x00010000);
        elstEntries.push(t.segDur, t.mediaTime, 0x00010000);
        const edts = box('edts', fullBox('elst', 0, 0, u32s([elstEntries.length / 3]), u32s(elstEntries)));
        return box('trak', tkhd, edts, mdia);
      };
      const buildMoov = mdatBase => {
        const mvhd = fullBox('mvhd', 0, 0, u32s([0, 0, MOVIE_TS, movieDur, 0x10000]), [1, 0], [0, 0], u32s([0, 0]), MATRIX,
          new Uint8Array(24), u32s([Math.max(...order) + 1]));
        return box('moov', mvhd, ...order.map(id => buildTrak(tracks[id], mdatBase)));
      };

      const ftyp = box('ftyp', str('isom'), u32s([512]), str('isomiso2avc1mp41'));
      const moovSize = buildMoov(0).length;
      const mdatBase = ftyp.length + moovSize + 8;
      const moovBytes = buildMoov(mdatBase);
      const out = new Uint8Array(ftyp.length + moovBytes.length + 8 + mdatLen);
      let pos = 0;
      out.set(ftyp, pos); pos += ftyp.length;
      out.set(moovBytes, pos); pos += moovBytes.length;
      out.set(u32s([mdatLen + 8]), pos); out.set(str('mdat'), pos + 4); pos += 8;
      chunks.forEach(c => {
        for (let i = c.first; i < c.first + c.count; i++) {
          const s = c.t.samples[i];
          out.set(src.subarray(s.off, s.off + s.size), pos); pos += s.size;
        }
      });
      return out;
    }
    // ---- MP4 FIX END ----

    async function startRecording() {
      if (!audioReady) return;
      if (!window.MediaRecorder || !canvas.captureStream || !audio.captureStream) {
        setStatus('This browser doesn’t support audio/video capture. Open the file in an updated Chrome.');
        return;
      }
      const canvasStream = canvas.captureStream(FPS);
      const audioStream = audio.captureStream();
      const audioTracks = audioStream.getAudioTracks();
      if (!audioTracks.length) {
        setStatus('O navegador não disponibilizou a faixa de áudio. Tenta abrir no Chrome e dar Play antes de gravar.');
        return;
      }
      const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
      // Prefer MP4 (H.264 + AAC), which is ready to post; fall back to WebM if the browser can't record MP4.
      const candidates = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
        'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
      // Good quality without heavy files: about 5-7 Mbps video at 60 fps + 192 kbps audio
      const vbps = Math.round(Math.min(8e6, Math.max(4e6, canvas.width * canvas.height * FPS * .1)));
      const opts = {videoBitsPerSecond: vbps, audioBitsPerSecond: 192000};
      if (mime) opts.mimeType = mime;
      chunks = [];
      try {recorder = new MediaRecorder(mixed, opts);}
      catch (e) {setStatus('Cannot start recording onn this browser.'); return;}
      recorder.ondataavailable = e => {if (e.data && e.data.size) chunks.push(e.data);};
      recorder.onstop = async () => {
        const isMp4 = (recorder.mimeType || mime).includes('mp4');
        mixed.getTracks().forEach(t => t.stop());
        recording = false;
        $('videoFormat').disabled = false;
        $('export').textContent = '● Record video';
        $('play').textContent = audio.paused ? '▶ Play' : 'Ⅱ Pausar';
        let blob = new Blob(chunks, {type: recorder.mimeType || mime || 'video/webm'});
        if (isMp4) {
          setStatus('Finalizing MP4…');
          try {
            // Makes the MP4 play with the right length on phones and in social apps
            const fixed = fixMp4(await blob.arrayBuffer());
            if (fixed) blob = new Blob([fixed], {type: 'video/mp4'});
          } catch (err) {console.error('Could not finalize the MP4, keeping the original recording.', err);}
        }
        lastVideoBlob = blob;
        if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
        lastVideoUrl = URL.createObjectURL(lastVideoBlob);
        lastVideoName = 'wavelab-beat-' + vf.label.replace(':', 'x') + (isMp4 ? '.mp4' : '.webm');
        $('download').disabled = false;
        setStatus(isMp4 ? 'Recording ready (MP4). Click on "Download video" to save it.'
          : 'Recording ready, but this browser only records WebM. Use an updated Chrome or Edge to get MP4.');
      };
      recording = true;
      $('videoFormat').disabled = true;
      $('download').disabled = true;
      recorder.start(250);
      $('export').textContent = '■ Stop recording';
      setStatus('Recording video + audio. Keep this tab open and visible, and click "Stop recording" when you\'re done.');
      if (audio.ended || audio.currentTime >= duration) audio.currentTime = 0;
      try {await audio.play(); $('play').textContent = 'Ⅱ Pausar';}
      catch (e) {setStatus('Allows audio playback in the browser and tries again.'); stopRecording();}
    }
    function stopRecording() {if (recorder && recorder.state !== 'inactive') recorder.stop();}
    $('download').addEventListener('click', () => {
      if (!lastVideoUrl) return;
      const a = document.createElement('a');
      a.href = lastVideoUrl;
      a.download = lastVideoName;
      document.body.appendChild(a); a.click(); a.remove();
    });
    $('export').addEventListener('click', () => {if (recording) stopRecording(); else startRecording();});
    function applyFormat() {
      vf = FORMATS[$('videoFormat').value];
      canvas.width = vf.w; canvas.height = vf.h;
      canvas.style.setProperty('--cw', vf.view + 'px');
      $('previewFormat').textContent = 'PREVIEW · ' + vf.label + ' · ' + vf.w + '×' + vf.h;
    }
    $('videoFormat').addEventListener('change', applyFormat);
    applyFormat();
    draw();