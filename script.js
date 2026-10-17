const $ = id => document.getElementById(id);
    const canvas = $('visual'), ctx = canvas.getContext('2d'), audio = $('audio');
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
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 30 * sc;
      ctx.fillStyle = '#101010'; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
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

    async function startRecording() {
      if (!audioReady) return;
      if (!window.MediaRecorder || !canvas.captureStream || !audio.captureStream) {
        setStatus('This browser doesn’t support audio/video capture. Open the file in an updated Chrome.');
        return;
      }
      const canvasStream = canvas.captureStream(30);
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
      // Good quality without heavy files: about 4-5 Mbps video + 192 kbps audio
      const vbps = Math.round(Math.min(6e6, Math.max(3e6, canvas.width * canvas.height * 4.5)));
      const opts = {videoBitsPerSecond: vbps, audioBitsPerSecond: 192000};
      if (mime) opts.mimeType = mime;
      chunks = [];
      try {recorder = new MediaRecorder(mixed, opts);}
      catch (e) {setStatus('Cannot start recording onn this browser.'); return;}
      recorder.ondataavailable = e => {if (e.data && e.data.size) chunks.push(e.data);};
      recorder.onstop = () => {
        const isMp4 = (recorder.mimeType || mime).includes('mp4');
        lastVideoBlob = new Blob(chunks, {type: recorder.mimeType || mime || 'video/webm'});
        if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
        lastVideoUrl = URL.createObjectURL(lastVideoBlob);
        lastVideoName = 'wavelab-beat-' + vf.label.replace(':', 'x') + (isMp4 ? '.mp4' : '.webm');
        $('videoFormat').disabled = false;
        $('download').disabled = false;
        mixed.getTracks().forEach(t => t.stop());
        recording = false;
        $('export').textContent = '● Record video';
        $('play').textContent = audio.paused ? '▶ Play' : 'Ⅱ Pausar';
        setStatus(isMp4 ? 'Recording ready (MP4). Click on "Download video" to save it.'
          : 'Recording ready, but this browser only records WebM. Use an updated Chrome or Edge to get MP4.');
      };
      recording = true;
      $('videoFormat').disabled = true;
      $('download').disabled = true;
      recorder.start(250);
      $('export').textContent = '■ Stop recording';
      setStatus('Recording video + audio. Click "Stop recording" when youre done.');
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