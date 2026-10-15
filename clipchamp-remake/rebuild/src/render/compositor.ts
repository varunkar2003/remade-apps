// WebGL2 compositor (Clipchamp composites with WebGL shaders: notes.md §2.3).
// One pass per layer (transform + colour filters + opacity); transitions render both
// clips into offscreen framebuffers and blend them with a transition shader.
import { itemAt, previousAdjacent, size, type Item, type Project, type TextStyle, type TransitionType } from "../model";

export interface Source { image: TexImageSource; width: number; height: number }
/** Supplies the current frame for a video/image item at timeline time t (null = not ready). */
export type SourceFn = (item: Item, t: number) => Source | null;

const LAYER_VS = `#version 300 es
in vec2 a_pos; uniform mat3 u_m; out vec2 v_uv;
void main() { v_uv = a_pos; vec3 p = u_m * vec3(a_pos, 1.0); gl_Position = vec4(p.xy, 0.0, 1.0); }`;

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex; uniform vec2 u_texel; uniform float u_opacity;
uniform float u_bright, u_contrast, u_sat, u_hue, u_gray, u_sepia, u_blur;
vec4 sampleBlur(vec2 uv) {
  if (u_blur <= 0.0) return texture(u_tex, uv);
  vec4 acc = vec4(0.0); float wsum = 0.0; float r = u_blur * 24.0;
  for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
    vec2 d = vec2(float(i), float(j)); float w = exp(-dot(d, d) / 8.0);
    acc += texture(u_tex, uv + d * u_texel * r / 3.0) * w; wsum += w;
  }
  return acc / wsum;
}
void main() {
  vec4 t = sampleBlur(v_uv);
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  c += u_bright * 0.4;
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + u_sat);
  if (u_hue != 0.0) {
    float a = u_hue * 3.14159265; float cs = cos(a), sn = sin(a);
    mat3 m = mat3(0.299 + 0.701*cs + 0.168*sn, 0.299 - 0.299*cs - 0.328*sn, 0.299 - 0.3*cs + 1.25*sn,
                  0.587 - 0.587*cs + 0.33*sn, 0.587 + 0.413*cs + 0.035*sn, 0.587 - 0.588*cs - 1.05*sn,
                  0.114 - 0.114*cs - 0.497*sn, 0.114 - 0.114*cs + 0.292*sn, 0.114 + 0.886*cs - 0.203*sn);
    c = m * c;
  }
  c = mix(c, vec3(l), u_gray);
  c = mix(c, vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))), u_sepia);
  float a = t.a * u_opacity;
  o = vec4(clamp(c, 0.0, 1.0) * a, a);
}`;

const TRANS_VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos; gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`;

const TRANS_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_a, u_b; uniform float u_p; uniform int u_type; uniform vec2 u_size;
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_a, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_b, uv); }
float edge(float x) { return smoothstep(-0.01, 0.01, x); }
void main() {
  float p = clamp(u_p, 0.0, 1.0); vec2 uv = v_uv;
  if (u_type == 1) { o = p < 0.5 ? A(uv) * (1.0 - 2.0 * p) : B(uv) * (2.0 * p - 1.0); }
  else if (u_type == 2) { o = mix(A(uv), B(uv), edge(p - uv.x)); }
  else if (u_type == 3) { o = mix(A(uv), B(uv), edge(uv.x - (1.0 - p))); }
  else if (u_type == 4) { o = mix(A(uv), B(uv), edge(p - uv.y)); }
  else if (u_type == 5) { o = mix(A(uv), B(uv), edge(uv.y - (1.0 - p))); }
  else if (u_type == 6) { o = uv.x < 1.0 - p ? A(uv + vec2(p, 0.0)) : B(uv - vec2(1.0 - p, 0.0)); }
  else if (u_type == 7) { o = uv.x > p ? A(uv - vec2(p, 0.0)) : B(uv + vec2(1.0 - p, 0.0)); }
  else if (u_type == 8) { vec2 z = 0.5 + (uv - 0.5) / (1.0 + p * 1.5); o = mix(A(z), B(uv), p); }
  else if (u_type == 9) { float r = distance(uv * u_size, u_size * 0.5) / length(u_size * 0.5); o = mix(A(uv), B(uv), edge(p * 1.05 - r)); }
  else if (u_type == 10) { float s = (1.0 - abs(2.0 * p - 1.0)) * 0.06 + 0.002; vec2 q = (floor(uv / s) + 0.5) * s; o = p < 0.5 ? A(q) : B(q); }
  else { o = mix(A(uv), B(uv), p); }
}`;

const TRANSITION_ID: Record<TransitionType, number> = {
  none: 0, crossfade: 0, fadeblack: 1, wipeleft: 2, wiperight: 3, wipeup: 4, wipedown: 5, slideleft: 6, slideright: 7, zoom: 8, circle: 9, pixelate: 10,
};

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, "a_pos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

// column-major mat3 helpers
type M = number[];
const mul = (a: M, b: M): M => {
  const r = new Array(9).fill(0);
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) for (let k = 0; k < 3; k++) r[c * 3 + rr] += a[k * 3 + rr] * b[c * 3 + k];
  return r;
};
const T = (x: number, y: number): M => [1, 0, 0, 0, 1, 0, x, y, 1];
const S = (x: number, y: number): M => [x, 0, 0, 0, y, 0, 0, 0, 1];
const R = (deg: number): M => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; };

export function fadeFactor(it: Item, t: number) {
  let f = 1;
  if (it.fadeIn > 0) f = Math.min(f, (t - it.start) / it.fadeIn);
  if (it.fadeOut > 0) f = Math.min(f, (it.start + it.duration - t) / it.fadeOut);
  return Math.max(0, Math.min(1, f));
}

/** Render text into a canvas sized to its content (frame-relative font size). */
export function renderText(s: TextStyle, frameH: number) {
  const px = Math.round((s.size * frameH) / 720);
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const font = `${s.bold ? "700" : "400"} ${px}px ${s.font}`;
  g.font = font;
  const lines = (s.content || " ").split("\n");
  const w = Math.max(...lines.map((l) => g.measureText(l).width));
  const lh = px * 1.25, pad = s.background !== "transparent" ? px * 0.35 : px * 0.1;
  c.width = Math.ceil(w + pad * 2); c.height = Math.ceil(lh * lines.length + pad * 2);
  if (s.background !== "transparent") {
    g.fillStyle = s.background;
    g.beginPath(); g.roundRect(0, 0, c.width, c.height, px * 0.2); g.fill();
  }
  g.font = font; g.fillStyle = s.color; g.textBaseline = "middle";
  g.textAlign = s.align; const x = s.align === "left" ? pad : s.align === "right" ? c.width - pad : c.width / 2;
  if (s.background === "transparent") { g.shadowColor = "rgba(0,0,0,.55)"; g.shadowBlur = px * 0.12; }
  lines.forEach((l, i) => g.fillText(l, x, pad + lh * i + lh / 2));
  return c;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private layer: WebGLProgram;
  private trans: WebGLProgram;
  private quad: WebGLVertexArrayObject;
  private textures = new Map<string, { tex: WebGLTexture; key?: string; w: number; h: number }>();
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private w = 0; private h = 0;
  private textCache = new Map<string, HTMLCanvasElement>();

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.layer = compile(gl, LAYER_VS, LAYER_FS);
    this.trans = compile(gl, TRANS_VS, TRANS_FS);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  private resize(w: number, h: number) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [0, 1].map(() => {
      const tex = this.newTex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private newTex() {
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload the item's current pixels; returns its texture + natural size. */
  private upload(it: Item, src: SourceFn, t: number) {
    const gl = this.gl;
    let entry = this.textures.get(it.id);
    if (it.kind === "text" && it.text) {
      const key = JSON.stringify(it.text) + this.h;
      if (entry?.key === key) return entry;
      let canvas = this.textCache.get(key);
      if (!canvas) { canvas = renderText(it.text, this.h); this.textCache.set(key, canvas); }
      if (!entry) { entry = { tex: this.newTex(), w: 0, h: 0 }; this.textures.set(it.id, entry); }
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      Object.assign(entry, { key, w: canvas.width, h: canvas.height });
      return entry;
    }
    const s = src(it, t);
    if (!s || !s.width || !s.height) return entry ?? null; // keep the last frame while a seek is pending
    if (!entry) { entry = { tex: this.newTex(), w: 0, h: 0 }; this.textures.set(it.id, entry); }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.image);
    entry.w = s.width; entry.h = s.height;
    return entry;
  }

  private drawLayer(it: Item, tex: { tex: WebGLTexture; w: number; h: number }, t: number) {
    const gl = this.gl, W = this.w, H = this.h;
    let dw: number, dh: number;
    if (it.kind === "text") { dw = tex.w * it.scale; dh = tex.h * it.scale; }
    else {
      const fit = it.fit === "cover" ? Math.max(W / tex.w, H / tex.h) : Math.min(W / tex.w, H / tex.h);
      dw = tex.w * fit * it.scale; dh = tex.h * fit * it.scale;
    }
    const clip: M = [2 / W, 0, 0, 0, -2 / H, 0, -1, 1, 1];
    const m = mul(clip, mul(T(it.x * W, it.y * H), mul(R(it.rotation), mul(S(dw, dh), T(-0.5, -0.5)))));
    gl.useProgram(this.layer);
    const u = (n: string) => gl.getUniformLocation(this.layer, n);
    gl.uniformMatrix3fv(u("u_m"), false, m);
    gl.uniform2f(u("u_texel"), 1 / tex.w, 1 / tex.h);
    gl.uniform1f(u("u_opacity"), it.opacity * fadeFactor(it, t));
    const f = it.filters;
    gl.uniform1f(u("u_bright"), f.brightness); gl.uniform1f(u("u_contrast"), f.contrast); gl.uniform1f(u("u_sat"), f.saturation);
    gl.uniform1f(u("u_hue"), f.hue); gl.uniform1f(u("u_gray"), f.grayscale); gl.uniform1f(u("u_sepia"), f.sepia); gl.uniform1f(u("u_blur"), f.blur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(u("u_tex"), 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw the whole frame at time t. Returns ids of items that had no frame ready. */
  render(p: Project, t: number, src: SourceFn): string[] {
    const [W, H] = size(p);
    this.resize(W, H);
    const gl = this.gl;
    const missing: string[] = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const bg = parseInt(p.background.slice(1), 16);
    gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const frame = 1 / p.fps;
    for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
      const track = p.tracks[ti];
      if (track.kind !== "visual" || track.hidden) continue;
      // a transition window straddles the cut between A (previous) and B
      const b = p.items.find((i) => i.trackId === track.id && i.transitionIn.type !== "none" &&
        t >= i.start - i.transitionIn.duration / 2 && t < i.start + i.transitionIn.duration / 2);
      const a = b && previousAdjacent(p, b);
      if (b && a) {
        const d = b.transitionIn.duration;
        const ta = Math.min(t, a.start + a.duration - frame), tb = Math.max(t, b.start);
        const texA = this.upload(a, src, ta), texB = this.upload(b, src, tb);
        if (!texA) missing.push(a.id);
        if (!texB) missing.push(b.id);
        [[a, texA, ta], [b, texB, tb]].forEach(([it, tex, tt], k) => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[k].fb);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (tex) this.drawLayer(it as Item, tex as any, tt as number);
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this.trans);
        const u = (n: string) => gl.getUniformLocation(this.trans, n);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex); gl.uniform1i(u("u_a"), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex); gl.uniform1i(u("u_b"), 1);
        gl.uniform1f(u("u_p"), (t - (b.start - d / 2)) / d);
        gl.uniform1i(u("u_type"), TRANSITION_ID[b.transitionIn.type]);
        gl.uniform2f(u("u_size"), W, H);
        gl.bindVertexArray(this.quad);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.activeTexture(gl.TEXTURE0);
        continue;
      }
      const it = itemAt(p, track.id, t);
      if (!it) continue;
      const tex = this.upload(it, src, t);
      if (!tex) { missing.push(it.id); continue; }
      this.drawLayer(it, tex, t);
    }
    return missing;
  }

  /** Drop textures for items that no longer exist. */
  prune(p: Project) {
    const live = new Set(p.items.map((i) => i.id));
    for (const [id, e] of this.textures) if (!live.has(id)) { this.gl.deleteTexture(e.tex); this.textures.delete(id); }
    if (this.textCache.size > 64) this.textCache.clear();
  }
}
