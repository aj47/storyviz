// Video export: every scene is played once, in order, for its length on an offscreen stage, frame by frame on a
// clock of its own, so the file is smooth however slow the machine draws. Each frame gets the sky painted behind
// it and the scene's on-screen text on top, the same way the page shows them, and is encoded to MP4 in the browser.
import { Stage } from './scene.js';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH, getFirstEncodableVideoCodec } from '/vendor/mediabunny.mjs';

// Where the on-screen text sits and how big it is, as shares of the frame: x and y are the middle of the text,
// size is the letter height against the frame's width. The page and the export both use these.
export const CAPTION = { x: 0.5, y: 0.72, size: 0.085, width: 0.86 };

export function drawCaption(ctx, text, W, H, pos = {}, size) {
  text = String(text || '').trim(); if (!text) return;
  const fs = Math.round((size || CAPTION.size) * W), lh = fs * 1.12, maxW = CAPTION.width * W - 0.3 * fs; // the page pads the words by .15em a side
  ctx.save();
  ctx.font = `800 ${fs}px Inter, system-ui, -apple-system, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last != null && ctx.measureText(last + ' ' + word).width <= maxW) lines[lines.length - 1] = last + ' ' + word; else lines.push(word);
  }
  const k = fs / 34, cx = (pos.x ?? CAPTION.x) * W, top = (pos.y ?? CAPTION.y) * H - ((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => {
    const y = top + i * lh;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 18 * k; ctx.fillStyle = '#000'; ctx.fillText(line, cx, y + 3 * k);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.lineJoin = 'round'; ctx.lineWidth = 2.4 * k; ctx.strokeStyle = '#000'; ctx.strokeText(line, cx, y);
    ctx.fillStyle = '#fff'; ctx.fillText(line, cx, y);
  });
  ctx.restore();
}

// scenes: [{ lines, sec, caption, capPos, capSize }]. Resolves to an MP4 Blob.
export async function exportVideo({ scenes, mode, style, size, fps = 30, onFrame, signal }) {
  const [W, H] = size;
  await document.fonts?.ready; // labels and on-screen text are drawn with the page's font
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H });
  if (!codec) throw new Error('This browser cannot encode video. Try a recent Chrome, Edge or Safari.');
  const stage = new Stage(document.createElement('div'), {}, { size: [W, H] });
  stage.setMode(mode); stage.setStyle(style);
  const frame = document.createElement('canvas'); frame.width = W; frame.height = H;
  const ctx = frame.getContext('2d');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(frame, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const total = scenes.reduce((a, s) => a + Math.round(s.sec * fps), 0); let n = 0;
  try {
    for (const [si, sc] of scenes.entries()) {
      stage.loadForExport(sc.lines, sc.sec);
      const frames = Math.round(sc.sec * fps);
      for (let f = 0; f < frames; f++) {
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const gl = stage.renderAt((f / fps) * 1000);
        const [top, hor] = stage.sky, g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, top); g.addColorStop(0.62, hor); g.addColorStop(1, hor);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(gl, 0, 0, W, H);
        if (sc.caption) drawCaption(ctx, sc.caption, W, H, sc.capPos, sc.capSize);
        await source.add(n / fps, 1 / fps);
        n++;
        onFrame?.({ n, total, scene: si, canvas: frame });
        // Let the page breathe now and then, so the progress bar and Cancel keep working.
        if (n % 6 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    stage.renderer.dispose(); stage.renderer.forceContextLoss();
  }
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
