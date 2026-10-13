/* Splash cursor: a small GPU stable-fluids solver (advection, vorticity
   confinement, pressure projection), drawn with multiply blending so ink
   in the four palette colours shows on a white page. Written for this project;
   the approach follows Stam's "Stable Fluids" as popularised by WebGL fluid demos. */

const COLORS = ["#4285F4", "#EA4335", "#FBBC05", "#34A853"];
const CFG = { SIM: 128, DYE: 1024, DENSITY_DISSIPATION: 3.5, VELOCITY_DISSIPATION: 2, PRESSURE: 0.1, PRESSURE_ITER: 20, CURL: 3, SPLAT_RADIUS: 0.2, SPLAT_FORCE: 6000, COLOR_SPEED: 10 };

const VS = `precision highp float;
attribute vec2 aPosition; varying vec2 vUv,vL,vR,vT,vB; uniform vec2 texelSize;
void main(){vUv=aPosition*.5+.5;vL=vUv-vec2(texelSize.x,0.);vR=vUv+vec2(texelSize.x,0.);vT=vUv+vec2(0.,texelSize.y);vB=vUv-vec2(0.,texelSize.y);gl_Position=vec4(aPosition,0.,1.);}`;
const FS: Record<string, string> = {
  clear: `precision mediump float;varying vec2 vUv;uniform sampler2D uTexture;uniform float value;void main(){gl_FragColor=value*texture2D(uTexture,vUv);}`,
  splat: `precision highp float;varying vec2 vUv;uniform sampler2D uTarget;uniform float aspectRatio;uniform vec3 color;uniform vec2 point;uniform float radius;
    void main(){vec2 p=vUv-point;p.x*=aspectRatio;vec3 s=exp(-dot(p,p)/radius)*color;vec3 b=texture2D(uTarget,vUv).xyz;gl_FragColor=vec4(b+s,1.);}`,
  advect: `precision highp float;varying vec2 vUv;uniform sampler2D uVelocity,uSource;uniform vec2 texelSize;uniform float dt,dissipation;
    void main(){vec2 c=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize;vec4 r=texture2D(uSource,c);gl_FragColor=r/(1.+dissipation*dt);}`,
  divergence: `precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
    void main(){float L=texture2D(uVelocity,vL).x,R=texture2D(uVelocity,vR).x,T=texture2D(uVelocity,vT).y,B=texture2D(uVelocity,vB).y;vec2 C=texture2D(uVelocity,vUv).xy;
    if(vL.x<0.)L=-C.x;if(vR.x>1.)R=-C.x;if(vT.y>1.)T=-C.y;if(vB.y<0.)B=-C.y;gl_FragColor=vec4(.5*(R-L+T-B),0.,0.,1.);}`,
  curl: `precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
    void main(){float L=texture2D(uVelocity,vL).y,R=texture2D(uVelocity,vR).y,T=texture2D(uVelocity,vT).x,B=texture2D(uVelocity,vB).x;gl_FragColor=vec4(.5*(R-L-T+B),0.,0.,1.);}`,
  vorticity: `precision highp float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity,uCurl;uniform float curl,dt;
    void main(){float L=texture2D(uCurl,vL).x,R=texture2D(uCurl,vR).x,T=texture2D(uCurl,vT).x,B=texture2D(uCurl,vB).x,C=texture2D(uCurl,vUv).x;
    vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L));f/=length(f)+.0001;f*=curl*C;f.y*=-1.;vec2 v=texture2D(uVelocity,vUv).xy+f*dt;gl_FragColor=vec4(clamp(v,-1000.,1000.),0.,1.);}`,
  pressure: `precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uDivergence;
    void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x,d=texture2D(uDivergence,vUv).x;gl_FragColor=vec4((L+R+B+T-d)*.25,0.,0.,1.);}`,
  gradient: `precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uVelocity;
    void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x;vec2 v=texture2D(uVelocity,vUv).xy-vec2(R-L,T-B);gl_FragColor=vec4(v,0.,1.);}`,
  display: `precision highp float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uTexture;uniform vec2 texelSize;
    void main(){vec3 c=texture2D(uTexture,vUv).rgb;
    vec3 lc=texture2D(uTexture,vL).rgb,rc=texture2D(uTexture,vR).rgb,tc=texture2D(uTexture,vT).rgb,bc=texture2D(uTexture,vB).rgb;
    vec3 n=normalize(vec3(length(rc)-length(lc),length(tc)-length(bc),length(texelSize)));float diff=clamp(dot(n,vec3(0.,0.,1.))+.7,.7,1.);c*=diff;
    float a=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c,clamp(a,0.,1.));}`,
};

export interface Fluid { setActive(a: boolean): void; burst(x: number, y: number): void; destroy(): void; }

export function startFluid(canvas: HTMLCanvasElement): Fluid | null {
  const gl = canvas.getContext("webgl2", { alpha: true, depth: false, stencil: false, antialias: false, premultipliedAlpha: true }) as WebGL2RenderingContext | null;
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
  gl.getExtension("OES_texture_float_linear");

  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s))); return s; };
  const vs = sh(gl.VERTEX_SHADER, VS);
  const P: Record<string, { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }> = {};
  for (const k in FS) {
    const p = gl.createProgram()!; gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS[k])); gl.bindAttribLocation(p, 0, "aPosition"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
    const u: Record<string, WebGLUniformLocation | null> = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
    P[k] = { p, u };
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(0);

  type FBO = { t: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; attach(i: number): number };
  const blit = (t: FBO | null) => {
    if (t) { gl.viewport(0, 0, t.w, t.h); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); }
    else { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
  const fbo = (w: number, h: number): FBO => {
    gl.activeTexture(gl.TEXTURE0); const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, fbo: f, w, h, attach(i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); return i; } };
  };
  const dbl = (w: number, h: number) => { let a = fbo(w, h), b = fbo(w, h); return { w, h, tx: 1 / w, ty: 1 / h, get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; } }; };
  const res = (r: number) => { let ar = gl.drawingBufferWidth / gl.drawingBufferHeight; if (ar < 1) ar = 1 / ar; const mn = Math.round(r), mx = Math.round(r * ar); return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: mx, h: mn } : { w: mn, h: mx }; };
  let dye: ReturnType<typeof dbl>, vel: ReturnType<typeof dbl>, prs: ReturnType<typeof dbl>, div: FBO, curlF: FBO;
  const init = () => { const s = res(CFG.SIM), d = res(CFG.DYE); dye = dbl(d.w, d.h); vel = dbl(s.w, s.h); prs = dbl(s.w, s.h); div = fbo(s.w, s.h); curlF = fbo(s.w, s.h); };
  const size = () => { const dpr = Math.min(1.5, devicePixelRatio || 1); const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; init(); } };
  size();
  const use = (k: string) => { gl.useProgram(P[k].p); return P[k].u; };

  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const colOf = (i: number, k = 0.32) => hex(COLORS[((i % 4) + 4) % 4]).map((v) => v * k);
  const splat = (x: number, y: number, dx: number, dy: number, c: number[]) => {
    gl.disable(gl.BLEND);
    const ar = canvas.width / canvas.height; const u = use("splat");
    gl.uniform1i(u.uTarget, vel.read.attach(0)); gl.uniform1f(u.aspectRatio, ar); gl.uniform2f(u.point, x, y); gl.uniform3f(u.color, dx, dy, 0);
    let r = CFG.SPLAT_RADIUS / 100; if (ar > 1) r *= ar; gl.uniform1f(u.radius, r); blit(vel.write); vel.swap();
    gl.uniform1i(u.uTarget, dye.read.attach(0)); gl.uniform3f(u.color, c[0], c[1], c[2]); blit(dye.write); dye.swap();
  };
  const step = (dt: number) => {
    gl.disable(gl.BLEND);
    let u = use("curl"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); gl.uniform1i(u.uVelocity, vel.read.attach(0)); blit(curlF);
    u = use("vorticity"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); gl.uniform1i(u.uVelocity, vel.read.attach(0)); gl.uniform1i(u.uCurl, curlF.attach(1)); gl.uniform1f(u.curl, CFG.CURL); gl.uniform1f(u.dt, dt); blit(vel.write); vel.swap();
    u = use("divergence"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); gl.uniform1i(u.uVelocity, vel.read.attach(0)); blit(div);
    u = use("clear"); gl.uniform1i(u.uTexture, prs.read.attach(0)); gl.uniform1f(u.value, CFG.PRESSURE); blit(prs.write); prs.swap();
    u = use("pressure"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); gl.uniform1i(u.uDivergence, div.attach(0));
    for (let i = 0; i < CFG.PRESSURE_ITER; i++) { gl.uniform1i(u.uPressure, prs.read.attach(1)); blit(prs.write); prs.swap(); }
    u = use("gradient"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); gl.uniform1i(u.uPressure, prs.read.attach(0)); gl.uniform1i(u.uVelocity, vel.read.attach(1)); blit(vel.write); vel.swap();
    u = use("advect"); gl.uniform2f(u.texelSize, vel.tx, vel.ty); const vid = vel.read.attach(0); gl.uniform1i(u.uVelocity, vid); gl.uniform1i(u.uSource, vid);
    gl.uniform1f(u.dt, dt); gl.uniform1f(u.dissipation, CFG.VELOCITY_DISSIPATION); blit(vel.write); vel.swap();
    gl.uniform1i(u.uVelocity, vel.read.attach(0)); gl.uniform1i(u.uSource, dye.read.attach(1)); gl.uniform1f(u.dissipation, CFG.DENSITY_DISSIPATION); blit(dye.write); dye.swap();
  };
  const render = () => {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.BLEND);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const u = use("display"); gl.uniform2f(u.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight); gl.uniform1i(u.uTexture, dye.read.attach(0)); blit(null);
  };

  let active = false, ci = 0, ct = 0, col = colOf(0), raf = 0, last = performance.now();
  const ptr = { x: 0, y: 0, px: 0, py: 0, moved: false, init: false };
  const toUV = (cx: number, cy: number) => { const dpr = canvas.width / innerWidth; return [cx * dpr / canvas.width, 1 - cy * dpr / canvas.height]; };
  const onMove = (e: PointerEvent) => { const [x, y] = toUV(e.clientX, e.clientY); ptr.px = ptr.init ? ptr.x : x; ptr.py = ptr.init ? ptr.y : y; ptr.x = x; ptr.y = y; ptr.init = true; ptr.moved = true; };
  const onDown = (e: PointerEvent) => { if (!active) return; const [x, y] = toUV(e.clientX, e.clientY); splat(x, y, (Math.random() - 0.5) * 900, (Math.random() - 0.5) * 900, colOf(ci + 1, 2.5)); };
  addEventListener("pointermove", onMove); addEventListener("pointerdown", onDown); addEventListener("resize", size);
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 60); last = now;
    if (active) {
      ct += dt * CFG.COLOR_SPEED; if (ct >= 1) { ct = 0; ci++; col = colOf(ci); }
      if (ptr.moved) { ptr.moved = false; const ar = canvas.width / canvas.height; let dx = ptr.x - ptr.px, dy = ptr.y - ptr.py; if (ar < 1) dx *= ar; else dy /= ar; splat(ptr.x, ptr.y, dx * CFG.SPLAT_FORCE, dy * CFG.SPLAT_FORCE, col); }
      step(dt); render();
      raf = requestAnimationFrame(loop);
    } else raf = 0;
  };
  return {
    setActive(a) { active = a; canvas.style.display = a ? "" : "none"; if (a && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); } },
    burst(cx, cy) { if (!active) return; const [x, y] = toUV(cx, cy); for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; splat(x, y, Math.cos(a) * 1400, Math.sin(a) * 1400, colOf(k, 1.6)); } },
    destroy() { cancelAnimationFrame(raf); removeEventListener("pointermove", onMove); removeEventListener("pointerdown", onDown); removeEventListener("resize", size); },
  };
}
