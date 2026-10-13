
/* ================= effects (preview) ================= */
const FX = {splash:true, swarm:false, tc:true, vel:true, glitch:true};
const GCOL = ["#4285F4","#EA4335","#FBBC05","#34A853"];
const hex2rgb = h=>{h=h.replace("#","");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]};

document.querySelectorAll("[data-fx]").forEach(cb=>cb.onchange=()=>{FX[cb.dataset.fx]=cb.checked;
  document.body.classList.toggle(cb.dataset.fx+"-on",cb.checked);
  if(cb.dataset.fx==="vel") document.querySelector(".velocity").style.display=cb.checked?"":"none";});
document.getElementById("pvMin").onclick=e=>{const p=document.getElementById("pv");p.classList.toggle("min");e.target.textContent=p.classList.contains("min")?"Show":"Hide"};
const _go = go; go = v=>{_go(v);document.body.classList.toggle("on-home",v==="home")};
const onHome = ()=>document.body.classList.contains("on-home");

/* ---------- Splash cursor: GPU fluid simulation (stable fluids: advect, curl/vorticity, pressure projection) ---------- */
(function(){
  const canvas = document.getElementById("splash");
  const CFG = {SIM:128, DYE:1024, DENSITY_DISSIPATION:3.5, VELOCITY_DISSIPATION:2, PRESSURE:0.1, PRESSURE_ITER:20,
               CURL:3, SPLAT_RADIUS:0.2, SPLAT_FORCE:6000, SHADING:true, COLOR_SPEED:10};
  const gl = canvas.getContext("webgl2",{alpha:true,depth:false,stencil:false,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:false});
  if(!gl || reduce || matchMedia("(pointer:coarse)").matches){ canvas.remove(); return; }
  if(!gl.getExtension("EXT_color_buffer_float")){ canvas.remove(); return; }
  gl.getExtension("OES_texture_float_linear");

  const VS = `precision highp float;
    attribute vec2 aPosition; varying vec2 vUv,vL,vR,vT,vB; uniform vec2 texelSize;
    void main(){vUv=aPosition*.5+.5;vL=vUv-vec2(texelSize.x,0.);vR=vUv+vec2(texelSize.x,0.);vT=vUv+vec2(0.,texelSize.y);vB=vUv-vec2(0.,texelSize.y);gl_Position=vec4(aPosition,0.,1.);}`;
  const FS = {
    clear:`precision mediump float;varying vec2 vUv;uniform sampler2D uTexture;uniform float value;void main(){gl_FragColor=value*texture2D(uTexture,vUv);}`,
    splat:`precision highp float;varying vec2 vUv;uniform sampler2D uTarget;uniform float aspectRatio;uniform vec3 color;uniform vec2 point;uniform float radius;
      void main(){vec2 p=vUv-point;p.x*=aspectRatio;vec3 s=exp(-dot(p,p)/radius)*color;vec3 b=texture2D(uTarget,vUv).xyz;gl_FragColor=vec4(b+s,1.);}`,
    advect:`precision highp float;varying vec2 vUv;uniform sampler2D uVelocity,uSource;uniform vec2 texelSize;uniform float dt,dissipation;
      void main(){vec2 c=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize;vec4 r=texture2D(uSource,c);gl_FragColor=r/(1.+dissipation*dt);}`,
    divergence:`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
      void main(){float L=texture2D(uVelocity,vL).x,R=texture2D(uVelocity,vR).x,T=texture2D(uVelocity,vT).y,B=texture2D(uVelocity,vB).y;vec2 C=texture2D(uVelocity,vUv).xy;
      if(vL.x<0.)L=-C.x;if(vR.x>1.)R=-C.x;if(vT.y>1.)T=-C.y;if(vB.y<0.)B=-C.y;gl_FragColor=vec4(.5*(R-L+T-B),0.,0.,1.);}`,
    curl:`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity;
      void main(){float L=texture2D(uVelocity,vL).y,R=texture2D(uVelocity,vR).y,T=texture2D(uVelocity,vT).x,B=texture2D(uVelocity,vB).x;gl_FragColor=vec4(.5*(R-L-T+B),0.,0.,1.);}`,
    vorticity:`precision highp float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uVelocity,uCurl;uniform float curl,dt;
      void main(){float L=texture2D(uCurl,vL).x,R=texture2D(uCurl,vR).x,T=texture2D(uCurl,vT).x,B=texture2D(uCurl,vB).x,C=texture2D(uCurl,vUv).x;
      vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L));f/=length(f)+.0001;f*=curl*C;f.y*=-1.;vec2 v=texture2D(uVelocity,vUv).xy+f*dt;gl_FragColor=vec4(clamp(v,-1000.,1000.),0.,1.);}`,
    pressure:`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uDivergence;
      void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x,d=texture2D(uDivergence,vUv).x;gl_FragColor=vec4((L+R+B+T-d)*.25,0.,0.,1.);}`,
    gradient:`precision mediump float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uPressure,uVelocity;
      void main(){float L=texture2D(uPressure,vL).x,R=texture2D(uPressure,vR).x,T=texture2D(uPressure,vT).x,B=texture2D(uPressure,vB).x;vec2 v=texture2D(uVelocity,vUv).xy-vec2(R-L,T-B);gl_FragColor=vec4(v,0.,1.);}`,
    display:`precision highp float;varying vec2 vUv,vL,vR,vT,vB;uniform sampler2D uTexture;uniform vec2 texelSize;
      void main(){vec3 c=texture2D(uTexture,vUv).rgb;
      vec3 lc=texture2D(uTexture,vL).rgb,rc=texture2D(uTexture,vR).rgb,tc=texture2D(uTexture,vT).rgb,bc=texture2D(uTexture,vB).rgb;
      vec3 n=normalize(vec3(length(rc)-length(lc),length(tc)-length(bc),length(texelSize)));float diff=clamp(dot(n,vec3(0.,0.,1.))+.7,.7,1.);c*=diff;
      float a=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c,clamp(a,0.,1.));}`
  };
  function sh(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw gl.getShaderInfoLog(s);return s}
  const vs = sh(gl.VERTEX_SHADER,VS);
  const P = {};
  for(const k in FS){const p=gl.createProgram();gl.attachShader(p,vs);gl.attachShader(p,sh(gl.FRAGMENT_SHADER,FS[k]));gl.bindAttribLocation(p,0,"aPosition");gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw gl.getProgramInfoLog(p);
    const u={};const n=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);for(let i=0;i<n;i++){const nm=gl.getActiveUniform(p,i).name;u[nm]=gl.getUniformLocation(p,nm)}P[k]={p,u}}
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,1,1,-1]),gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,0,2,3]),gl.STATIC_DRAW);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);
  function blit(t){if(t){gl.viewport(0,0,t.w,t.h);gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo)}else{gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.bindFramebuffer(gl.FRAMEBUFFER,null)}gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0)}
  function fbo(w,h){gl.activeTexture(gl.TEXTURE0);const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,k,v);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,w,h,0,gl.RGBA,gl.HALF_FLOAT,null);
    const f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    return {t,fbo:f,w,h,tx:1/w,ty:1/h,attach(i){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,t);return i}}}
  function dbl(w,h){let a=fbo(w,h),b=fbo(w,h);return {w,h,tx:1/w,ty:1/h,get read(){return a},get write(){return b},swap(){[a,b]=[b,a]}}}
  function res(r){let ar=gl.drawingBufferWidth/gl.drawingBufferHeight;if(ar<1)ar=1/ar;const mn=Math.round(r),mx=Math.round(r*ar);
    return gl.drawingBufferWidth>gl.drawingBufferHeight?{w:mx,h:mn}:{w:mn,h:mx}}
  let dye,vel,div,curlF,prs;
  function init(){const s=res(CFG.SIM),d=res(CFG.DYE);dye=dbl(d.w,d.h);vel=dbl(s.w,s.h);div=fbo(s.w,s.h);curlF=fbo(s.w,s.h);prs=dbl(s.w,s.h)}
  function size(){const dpr=Math.min(1.5,devicePixelRatio||1);const w=Math.floor(innerWidth*dpr),h=Math.floor(innerHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;init();}}
  size(); addEventListener("resize",size);

  function use(k){gl.useProgram(P[k].p);return P[k].u}
  function splat(x,y,dx,dy,col){
    const ar=canvas.width/canvas.height;
    let u=use("splat");gl.uniform1i(u.uTarget,vel.read.attach(0));gl.uniform1f(u.aspectRatio,ar);gl.uniform2f(u.point,x,y);
    gl.uniform3f(u.color,dx,dy,0);let r=CFG.SPLAT_RADIUS/100;if(ar>1)r*=ar;gl.uniform1f(u.radius,r);blit(vel.write);vel.swap();
    gl.uniform1i(u.uTarget,dye.read.attach(0));gl.uniform3f(u.color,col[0],col[1],col[2]);blit(dye.write);dye.swap();
  }
  function step(dt){
    gl.disable(gl.BLEND);
    let u=use("curl");gl.uniform2f(u.texelSize,vel.tx,vel.ty);gl.uniform1i(u.uVelocity,vel.read.attach(0));blit(curlF);
    u=use("vorticity");gl.uniform2f(u.texelSize,vel.tx,vel.ty);gl.uniform1i(u.uVelocity,vel.read.attach(0));gl.uniform1i(u.uCurl,curlF.attach(1));gl.uniform1f(u.curl,CFG.CURL);gl.uniform1f(u.dt,dt);blit(vel.write);vel.swap();
    u=use("divergence");gl.uniform2f(u.texelSize,vel.tx,vel.ty);gl.uniform1i(u.uVelocity,vel.read.attach(0));blit(div);
    u=use("clear");gl.uniform1i(u.uTexture,prs.read.attach(0));gl.uniform1f(u.value,CFG.PRESSURE);blit(prs.write);prs.swap();
    u=use("pressure");gl.uniform2f(u.texelSize,vel.tx,vel.ty);gl.uniform1i(u.uDivergence,div.attach(0));
    for(let i=0;i<CFG.PRESSURE_ITER;i++){gl.uniform1i(u.uPressure,prs.read.attach(1));blit(prs.write);prs.swap()}
    u=use("gradient");gl.uniform2f(u.texelSize,vel.tx,vel.ty);gl.uniform1i(u.uPressure,prs.read.attach(0));gl.uniform1i(u.uVelocity,vel.read.attach(1));blit(vel.write);vel.swap();
    u=use("advect");gl.uniform2f(u.texelSize,vel.tx,vel.ty);const vid=vel.read.attach(0);gl.uniform1i(u.uVelocity,vid);gl.uniform1i(u.uSource,vid);
    gl.uniform1f(u.dt,dt);gl.uniform1f(u.dissipation,CFG.VELOCITY_DISSIPATION);blit(vel.write);vel.swap();
    gl.uniform1i(u.uVelocity,vel.read.attach(0));gl.uniform1i(u.uSource,dye.read.attach(1));gl.uniform1f(u.dissipation,CFG.DENSITY_DISSIPATION);blit(dye.write);dye.swap();
  }
  function render(){
    gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.enable(gl.BLEND);
    gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    const u=use("display");gl.uniform2f(u.texelSize,1/gl.drawingBufferWidth,1/gl.drawingBufferHeight);gl.uniform1i(u.uTexture,dye.read.attach(0));blit(null);
  }
  // colours: cycle through the four palette colours (intensity tuned for a white page)
  let ci=0,ct=0;const colOf=i=>hex2rgb(GCOL[i%4]).map(v=>v/255*0.32);let col=colOf(0);
  const ptr={x:0,y:0,px:0,py:0,moved:false,down:false};
  addEventListener("pointermove",e=>{const dpr=canvas.width/innerWidth;ptr.px=ptr.x;ptr.py=ptr.y;ptr.x=e.clientX*dpr/canvas.width;ptr.y=1-e.clientY*dpr/canvas.height;
    if(!ptr.init){ptr.px=ptr.x;ptr.py=ptr.y;ptr.init=true}ptr.moved=true});
  addEventListener("pointerdown",e=>{if(!FX.splash||!onHome())return;const dpr=canvas.width/innerWidth;const x=e.clientX*dpr/canvas.width,y=1-e.clientY*dpr/canvas.height;
    const c=colOf(ci+1).map(v=>v*8);splat(x,y,(Math.random()-.5)*900,(Math.random()-.5)*900,c)});
  let last=performance.now(), idle=0;
  function loop(now){
    const dt=Math.min((now-last)/1000,1/60);last=now;
    const active=FX.splash&&onHome();
    canvas.style.display=active?"":"none";
    if(active){
      ct+=dt*CFG.COLOR_SPEED;if(ct>=1){ct=0;ci++;col=colOf(ci)}
      if(ptr.moved){ptr.moved=false;const ar=canvas.width/canvas.height;let dx=ptr.x-ptr.px,dy=ptr.y-ptr.py;if(ar<1)dx*=ar;else dy/=ar;
        splat(ptr.x,ptr.y,dx*CFG.SPLAT_FORCE,dy*CFG.SPLAT_FORCE,col)}
      step(dt);render();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();

/* ---------- Swarm cursor (optional): particles follow the pointer, curl into eddies, pour around hovered buttons ---------- */
(function(){
  const cv=document.getElementById("swarm"),ctx=cv.getContext("2d");
  let W=0,H=0;const DPR=Math.min(2,devicePixelRatio||1);
  function rs(){W=innerWidth;H=innerHeight;cv.width=W*DPR;cv.height=H*DPR;ctx.setTransform(DPR,0,0,DPR,0,0)}rs();addEventListener("resize",rs);
  const COUNT=matchMedia("(pointer:coarse)").matches?0:Math.round(Math.min(1000,W*H/1400));
  const P=Array.from({length:COUNT},(_,i)=>({x:W*.7,y:H*.45,vx:0,vy:0,a:Math.random()*6.28,r:4+Math.pow(Math.random(),1.4)*70,s:.6+Math.random()*1.3,f:.006+Math.pow(Math.random(),1.8)*.05,c:GCOL[i%4],ph:Math.random()*6.28}));
  const M={x:W*.7,y:H*.45,sx:W*.7,sy:H*.45,btn:null,last:0};
  const hero=document.querySelector(".hero");
  addEventListener("pointermove",e=>{M.x=e.clientX;M.y=e.clientY;M.last=1;const b=e.target.closest&&e.target.closest(".hero .btn");M.btn=b?b.getBoundingClientRect():null});
  const curl=(x,y,t)=>{const s=.0065;return Math.sin(x*s+t*.0006)*Math.cos(y*s*1.3-t*.0005)+Math.sin((x+y)*s*.7+t*.0004)*.6};
  let alpha=0,tp=performance.now();
  function frame(t){const dt=Math.min(32,t-tp);tp=t;
    ctx.globalCompositeOperation="destination-out";ctx.fillStyle="rgba(0,0,0,.3)";ctx.fillRect(0,0,W,H);ctx.globalCompositeOperation="source-over";
    const r=hero.getBoundingClientRect();const inside=M.last&&M.y>=r.top&&M.y<=r.bottom;
    const on=FX.swarm&&!reduce&&COUNT&&onHome();
    alpha+=((on&&inside?1:0)-alpha)*.08;
    if(on&&alpha>.01){M.sx+=(M.x-M.sx)*.18;M.sy+=(M.y-M.sy)*.18;
      for(const p of P){let tx,ty;
        if(M.btn){p.a+=.012*p.s;const b=M.btn,pad=10+p.r*.18,cx=b.left+b.width/2,cy=b.top+b.height/2,rx=b.width/2+pad,ry=b.height/2+pad;const ca=Math.cos(p.a),sa=Math.sin(p.a),k=1/Math.max(Math.abs(ca)/rx,Math.abs(sa)/ry);tx=cx+ca*k;ty=cy+sa*k}
        else{p.a+=(.006+.12/p.r)*p.s;const ang=p.a+curl(p.x,p.y,t)*1.4;tx=M.sx+Math.cos(ang)*p.r;ty=M.sy+Math.sin(ang)*p.r}
        const f=M.btn?Math.max(.03,p.f*1.6):p.f;p.vx+=(tx-p.x)*f;p.vy+=(ty-p.y)*f;
        const fl=curl(p.x+p.ph*40,p.y,t);p.vx+=Math.cos(fl*3.2+p.ph)*.55;p.vy+=Math.sin(fl*3.2+p.ph)*.55;
        p.vx*=.9;p.vy*=.9;p.x+=p.vx*dt/16;p.y+=p.vy*dt/16;
        ctx.globalAlpha=alpha*.8;ctx.fillStyle=p.c;ctx.fillRect(p.x,p.y,2,2)}
      ctx.globalAlpha=1}
    requestAnimationFrame(frame)}
  requestAnimationFrame(frame);
})();

/* ---------- Scroll velocity: two marquee rows whose speed follows scroll speed ---------- */
(function(){
  const algos=["Dijkstra","Prim","Kruskal","Bellman-Ford","Floyd–Warshall","Johnson","Knapsack DP","Local search"];
  const rts=sol.policy.routes.filter(r=>r.path.length>2).slice(0,10).map(r=>`${r.client_name} to ${r.replica_name} ${r.latency_ms.toFixed(1)} ms`);
  const fill=(id,items)=>{const row=document.getElementById(id);const html=items.map(x=>`<span><i class="sep"></i>${x}</span>`).join("");row.innerHTML=html+html+html;return row};
  const r1=fill("vr1",algos),r2=fill("vr2",rts);
  let x1=0,x2=0,lastY=scrollY,vel=0,dir=1;
  function tick(){const dy=scrollY-lastY;lastY=scrollY;vel+=(dy-vel)*.12;if(Math.abs(dy)>.5)dir=Math.sign(dy);
    const boost=1+Math.min(12,Math.abs(vel)*.35),base=reduce?0:.55,w1=r1.scrollWidth/3,w2=r2.scrollWidth/3;
    x1=(x1-base*boost*dir)%w1;x2=(x2+base*.8*boost*dir)%w2;if(x2>0)x2-=w2;if(x1>0)x1-=w1;
    r1.style.transform=`translate3d(${x1}px,0,0) skewX(${Math.max(-12,Math.min(12,-vel*.25))}deg)`;r2.style.transform=`translate3d(${x2}px,0,0)`;
    requestAnimationFrame(tick)}
  requestAnimationFrame(tick);
})();

/* ---------- Text cursor: latency packets trail the pointer over the pipeline ---------- */
(function(){
  const zone=document.getElementById("tcZone");
  const words=sol.policy.routes.filter(r=>r.latency_ms>0).map(r=>r.latency_ms.toFixed(1)+" ms").concat(["O(E log V)","Θ(V³)","Θ(nW)","α(n)"]);
  const TC=["#1A73E8","#D93025","#E37400","#188038"]; // darker steps of the palette so the small text stays readable on white
  let last=0,lx=0,ly=0,k=0;
  zone.addEventListener("pointermove",e=>{
    if(!FX.tc||reduce)return;const now=performance.now(),d=Math.hypot(e.clientX-lx,e.clientY-ly);
    if(now-last<45||d<18)return;last=now;lx=e.clientX;ly=e.clientY;
    const el=document.createElement("span");el.className="tc-item";el.textContent=words[k%words.length];el.style.color=TC[k%4];k++;
    el.style.left=e.clientX+"px";el.style.top=e.clientY+"px";document.body.appendChild(el);
    const dx=(Math.random()-.5)*60,dy2=-20-Math.random()*40,rot=(Math.random()-.5)*30;
    el.animate([{opacity:0,transform:"translate(-50%,-50%) scale(.6)"},{opacity:1,transform:"translate(-50%,-50%) scale(1)",offset:.15},
      {opacity:0,transform:`translate(calc(-50% + ${dx}px), calc(-50% + ${dy2}px)) scale(.9) rotate(${rot}deg)`}],{duration:1300,easing:"cubic-bezier(.2,.7,.2,1)"}).onfinish=()=>el.remove();
  });
})();
