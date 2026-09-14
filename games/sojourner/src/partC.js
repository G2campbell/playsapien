(function(){
"use strict";
var ASSETS = window.SOJOURNER_ASSETS || './assets/';
var AV = window.SOJOURNER_V ? ('?v=' + window.SOJOURNER_V) : '';
function A(p){ return ASSETS + p + AV; }
var INLINE_EL = document.getElementById('gamedata');
var INLINE = !!INLINE_EL;
var GD = null;

/* ---------------- decoding ---------------- */
function b64bytes(b64){
  var bin = atob(b64), n = bin.length, a = new Uint8Array(n);
  for(var i=0;i<n;i++) a[i] = bin.charCodeAt(i);
  return a;
}
function decodeLines(bytes){
  var i = 0;
  function g(){ var shift=0,res=0,b;
    do{ b = bytes[i++]; res |= (b & 0x7f) << shift; shift += 7; } while(b & 0x80);
    return (res>>>1) ^ -(res & 1);
  }
  var n = g(), meta = [], total = 0, tmp = [];
  for(var k=0;k<n;k++){
    var cnt=g(), o1=g(), o2=g(), px=0, py=0, pts=new Int16Array(cnt*2);
    for(var j=0;j<cnt;j++){ px+=g(); py+=g(); pts[j*2]=px; pts[j*2+1]=py; }
    tmp.push(pts); meta.push({o1:o1,o2:o2,start:total,count:cnt}); total+=cnt;
  }
  var flat = new Int16Array(total*2), off=0;
  for(var m=0;m<tmp.length;m++){ flat.set(tmp[m], off); off += tmp[m].length; }
  return {meta:meta, coords:flat};
}

/* ---------------- geo helpers ---------------- */
var D2R = Math.PI/180, R_EARTH = 6371.0088;
function unitVec(lonDeg, latDeg, out){
  var la = latDeg*D2R, lo = lonDeg*D2R, c = Math.cos(la);
  out[0] = c*Math.cos(lo); out[1] = Math.sin(la); out[2] = -c*Math.sin(lo);
  return out;
}
function gcKm(lon1,lat1,lon2,lat2){
  var p1=lat1*D2R, p2=lat2*D2R, dp=(lat2-lat1)*D2R, dl=(lon2-lon1)*D2R;
  var a=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2*R_EARTH*Math.asin(Math.min(1,Math.sqrt(a)));
}

/* ---------------- scene ---------------- */
var wrap = document.getElementById('glwrap');
var renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
renderer.setClearColor(0x0C0B0A, 1);
wrap.appendChild(renderer.domElement);
var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
var globe = new THREE.Group(); scene.add(globe);

var BASE_FOV = 38;
var view = { lon: -28, lat: 20, dist: 3.55 };
var target = { lon: -28, lat: 20, dist: 3.55 };
// 1.16 put roughly 1.9 km under every screen pixel at the closest the camera
// would come, which left the District of Columbia twelve pixels wide -- a
// quarter of a fingertip. 1.12 makes it nineteen. Going further is tempting and
// wrong: the deepest terrain tiles are 8192 px around, about 4.9 km a texel, so
// past this the map turns to smeared paint. The rest of the reach comes from the
// near-miss assist in the game layer, not from more magnification.
var MIN_D = 1.12, MAX_D = 4.3;

var idCanvas = document.createElement('canvas');
idCanvas.width = 4096; idCanvas.height = 2048;
var idCtx = idCanvas.getContext('2d', {willReadFrequently:true});

var maskData = new Uint8Array(4096*4);
var maskTex = new THREE.DataTexture(maskData, 4096, 1, THREE.RGBAFormat);
maskTex.magFilter = maskTex.minFilter = THREE.NearestFilter;
maskTex.generateMipmaps = false; maskTex.needsUpdate = true;

var NEUTRAL = new THREE.DataTexture(new Uint8Array([128,128,128,255]), 1, 1, THREE.RGBAFormat);
NEUTRAL.needsUpdate = true;
var uniforms = {
  uTerrain:{value:NEUTRAL}, uId:{value:NEUTRAL}, uMask:{value:maskTex},
  uDetail:{value:NEUTRAL}, uDetailAmt:{value:0.0}, uHasDetail:{value:0},
  uAtlas:{value:NEUTRAL}, uAtlasOn:{value:0}, uAtlasRect:{value:new THREE.Vector4(0,0,1,1)},
  uHasId:{value:0},
  uSel:{value:0}, uShowMask:{value:0},
  uSelCol:{value:new THREE.Color(0xFF6600)}, uSelAmt:{value:0.45},
  uAnsCol:{value:new THREE.Color(0x0137FF)}, uAnsAmt:{value:0.15},
  uOthCol:{value:new THREE.Color(0xAA0FFF)}, uOthAmt:{value:0.15},
  uQ1:{value:new THREE.Color(0x0137FF)}, uQ2:{value:new THREE.Color(0x5647AA)},
  uQ3:{value:new THREE.Color(0xAA5655)}, uQ4:{value:new THREE.Color(0xFF6600)},
  // slot 5 is the place you are in the middle of choosing: a plain darkening,
  // so it can never be mistaken for an answer already on the board
  uQ5:{value:new THREE.Color(0x000000)},
  uQuizAmt:{value:0.5}, uChooseAmt:{value:0.30}
};
var sphereMat = new THREE.ShaderMaterial({
  uniforms: uniforms,
  vertexShader: [
    'varying vec2 vUv; varying vec3 vN;',
    'void main(){ vUv = uv; vN = normalize(normalMatrix * normal);',
    ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'].join('\n'),
  fragmentShader: [
    'uniform sampler2D uTerrain; uniform sampler2D uId; uniform sampler2D uMask;',
    'uniform sampler2D uDetail; uniform sampler2D uAtlas;',
    'uniform float uDetailAmt; uniform float uHasDetail;',
    'uniform float uAtlasOn; uniform vec4 uAtlasRect;',
    'uniform float uHasId; uniform float uSel; uniform float uShowMask;',
    'uniform vec3 uSelCol; uniform float uSelAmt; uniform vec3 uAnsCol; uniform float uAnsAmt;',
    'uniform vec3 uOthCol; uniform float uOthAmt;',
    'uniform vec3 uQ1; uniform vec3 uQ2; uniform vec3 uQ3; uniform vec3 uQ4; uniform vec3 uQ5;',
    'uniform float uQuizAmt; uniform float uChooseAmt;',
    'varying vec2 vUv; varying vec3 vN;',
    'void main(){',
    '  vec3 col = texture2D(uTerrain, vUv).rgb;',
    '  float dtl = 0.0; float has = 0.0;',
    '  if(uAtlasOn > 0.5){',
    '    vec2 a = (vUv - uAtlasRect.xy) / uAtlasRect.zw;',
    '    if(a.x >= 0.0 && a.x <= 1.0 && a.y >= 0.0 && a.y <= 1.0){',
    '      dtl = texture2D(uAtlas, a).r*2.0 - 1.0; has = 1.0;',
    '    }',
    '  }',
    '  if(has < 0.5 && uHasDetail > 0.5){',
    '    dtl = texture2D(uDetail, vUv).r*2.0 - 1.0; has = 1.0;',
    '  }',
    '  if(has > 0.5) col = clamp(col * (1.0 + uDetailAmt*dtl), 0.0, 1.0);',
    '  if(uHasId > 0.5){',
    '    vec4 idc = texture2D(uId, vUv);',
    '    float id = floor(idc.r*255.0+0.5) + floor(idc.g*255.0+0.5)*256.0;',
    '    if(id > 0.5){',
    '      if(uShowMask > 0.5){',
    '        vec4 m = texture2D(uMask, vec2((id+0.5)/4096.0, 0.5));',
    '        col = mix(col, vec3(0.529,0.518,0.506), m.g*0.40);',
    '        col = mix(col, uOthCol, m.b*uOthAmt);',
    '        col = mix(col, uAnsCol, m.r*uAnsAmt);',
    '        float qi = floor(m.a*255.0 + 0.5);',
    '        if(qi > 4.5){ col = mix(col, uQ5, uChooseAmt); }',
    '        else if(qi > 0.5){',
    '          vec3 qc = uQ1;',
    '          if(qi > 3.5) qc = uQ4; else if(qi > 2.5) qc = uQ3; else if(qi > 1.5) qc = uQ2;',
    '          col = mix(col, qc, uQuizAmt);',
    '        }',
    // A wash of blue over blue water, or a darkening over dark water, says almost
    // nothing. Hatch it instead: diagonal lines ruled in the map\'s own texel
    // space, so they stay pinned to the sea rather than sliding as the globe turns.
    '        float wsh = max(max(m.r, m.b), step(0.5, qi));',
    '        if(idc.b > 0.5 && wsh > 0.02){',
    '          float dg = vUv.x*4096.0 + vUv.y*2048.0;',
    '          float st = step(0.62, fract(dg/13.0));',
    '          col = mix(col, vec3(0.88,0.94,1.0), st*0.42*wsh);',
    '        }',
    '      }',
    '      if(uSel > 0.5 && abs(id-uSel) < 0.5) col = mix(col, uSelCol, uSelAmt);',
    '    }',
    '  }',
    '  float rim = 1.0 - max(dot(vN, vec3(0.0,0.0,1.0)), 0.0);',
    '  col *= 1.0 - 0.55*pow(rim, 3.2);',
    '  col += vec3(0.10,0.16,0.20) * pow(rim, 5.0) * 0.85;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'].join('\n')
});
var sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 90), sphereMat);
globe.add(sphere);

/* ---------------- border geometry ---------------- */
var BORD = {};
function buildThin(set, color, opacity, radius){
  var meta=set.meta, co=set.coords, segs=0, i;
  for(i=0;i<meta.length;i++) segs += (meta[i].count-1);
  var pos = new Float32Array(segs*6), o=0, v=[0,0,0];
  for(i=0;i<meta.length;i++){
    var m=meta[i], s=m.start;
    for(var j=0;j<m.count-1;j++){
      unitVec(co[(s+j)*2]/100, co[(s+j)*2+1]/100, v);
      pos[o++]=v[0]*radius; pos[o++]=v[1]*radius; pos[o++]=v[2]*radius;
      unitVec(co[(s+j+1)*2]/100, co[(s+j+1)*2+1]/100, v);
      pos[o++]=v[0]*radius; pos[o++]=v[1]*radius; pos[o++]=v[2]*radius;
    }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  var ls = new THREE.LineSegments(g,
    new THREE.LineBasicMaterial({color:color, transparent:true, opacity:opacity, depthWrite:false}));
  ls.renderOrder = 1; globe.add(ls);
  return ls;
}
var coastLine = null, borderMode = 'beginner';
// Countries+focus draws internal borders for one country only, so the admin
// lines are rebuilt filtered to that country and swapped in for the full set.
var focusAdmin = null, focusLine = null, focusLineFor = null;
function buildFocusLine(a){
  if(focusLineFor === a && focusLine) return focusLine;
  if(focusLine){ globe.remove(focusLine); focusLine.geometry.dispose(); focusLine = null; }
  var S = BORD.admin;
  if(!S || !GD) return null;
  var meta = S.meta, co = S.coords, keep = [], i;
  for(i=0;i<meta.length;i++){
    var m = meta[i];
    if(GD.gA[m.o1] === a && GD.gA[m.o2] === a) keep.push(m);
  }
  var segs = 0;
  for(i=0;i<keep.length;i++) segs += (keep[i].count-1);
  var g = fatGeometry(Math.max(1, segs)), n = 0, p=[0,0,0], q=[0,0,0];
  for(i=0;i<keep.length;i++){
    var k = keep[i], st = k.start;
    for(var j=0;j<k.count-1;j++){
      unitVec(co[(st+j)*2]/100, co[(st+j)*2+1]/100, p);
      unitVec(co[(st+j+1)*2]/100, co[(st+j+1)*2+1]/100, q);
      pushSegment(g, n++, [p[0]*1.0017,p[1]*1.0017,p[2]*1.0017],
                          [q[0]*1.0017,q[1]*1.0017,q[2]*1.0017]);
    }
  }
  g.setDrawRange(0, n*6); g.computeBoundingSphere();
  focusLine = new THREE.Mesh(g, fatMaterial(0x6A7F8A, 0.92, ADMIN_W));
  focusLine.frustumCulled = false; focusLine.renderOrder = 2;
  globe.add(focusLine); focusLineFor = a;
  return focusLine;
}
function applyBorderMode(){
  var showAdmin = (borderMode === 'beginner');
  if(coastLine)   coastLine.visible   = (borderMode !== 'expert');
  if(countryLine) countryLine.visible = (borderMode !== 'expert');
  if(focusAdmin === null || focusAdmin === undefined){
    if(focusLine) focusLine.visible = false;
    if(adminLine) adminLine.visible = showAdmin;
  } else {
    if(adminLine) adminLine.visible = false;
    var f = buildFocusLine(focusAdmin);
    if(f) f.visible = showAdmin;
  }
}
function setBorderMode(m){ borderMode = m; applyBorderMode(); }
function setFocusAdmin(a){ focusAdmin = (a === undefined ? null : a); applyBorderMode(); }
var uRes = { value: new THREE.Vector2(1,1) };
var FAT_VERT = [
  'attribute vec3 aOther; attribute float aSide; attribute float aDir; attribute float aW;',
  'uniform vec2 uRes; uniform float uWidth;',
  'void main(){',
  '  vec4 cs = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '  vec4 co = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);',
  '  vec2 ns = cs.xy/cs.w, no = co.xy/co.w;',
  '  vec2 d = (no - ns) * uRes * 0.5;',
  '  float L = length(d);',
  '  vec2 raw = (L > 1e-6) ? d/L : vec2(1.0, 0.0);',
  '  vec2 dir = raw * aDir;',
  '  vec2 nrm = vec2(-dir.y, dir.x) * aSide;',
  '  vec2 cap = -raw;',
  '  cs.xy += (nrm + cap) * (uWidth * aW) * cs.w / uRes;',
  '  gl_Position = cs;',
  '}'].join('\n');
var FAT_FRAG = [
  'uniform vec3 uColor; uniform float uOpacity;',
  'void main(){ gl_FragColor = vec4(uColor, uOpacity); }'].join('\n');
function fatMaterial(color, opacity, widthPx){
  return new THREE.ShaderMaterial({
    uniforms:{ uRes:uRes, uWidth:{value:widthPx}, uColor:{value:new THREE.Color(color)},
               uOpacity:{value:opacity} },
    vertexShader:FAT_VERT, fragmentShader:FAT_FRAG,
    transparent:true, depthWrite:false, side:THREE.DoubleSide
  });
}
function fatGeometry(maxSeg){
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSeg*6*3),3));
  g.setAttribute('aOther',   new THREE.BufferAttribute(new Float32Array(maxSeg*6*3),3));
  g.setAttribute('aSide',    new THREE.BufferAttribute(new Float32Array(maxSeg*6),1));
  g.setAttribute('aDir',     new THREE.BufferAttribute(new Float32Array(maxSeg*6),1));
  var w = new Float32Array(maxSeg*6); w.fill(1);
  g.setAttribute('aW',       new THREE.BufferAttribute(w,1));
  g.setDrawRange(0,0);
  return g;
}
var VSIDE=[-1,1,-1,-1,1,1], VDIR=[1,1,-1,-1,1,-1], VATB=[0,0,1,1,0,1];
function pushSegment(g, n, a, b, wa, wb){
  var P=g.attributes.position.array, O=g.attributes.aOther.array;
  var S=g.attributes.aSide.array, D=g.attributes.aDir.array, W=g.attributes.aW.array;
  if(wa === undefined) wa = 1; if(wb === undefined) wb = wa;
  for(var k=0;k<6;k++){
    var self = VATB[k] ? b : a, oth = VATB[k] ? a : b, i3 = (n*6+k)*3;
    P[i3]=self[0]; P[i3+1]=self[1]; P[i3+2]=self[2];
    O[i3]=oth[0];  O[i3+1]=oth[1];  O[i3+2]=oth[2];
    S[n*6+k]=VSIDE[k]; D[n*6+k]=VDIR[k];
    W[n*6+k]= VATB[k] ? wb : wa;
  }
}
function fatFromSet(set, radius){
  var meta=set.meta, co=set.coords, segs=0, i;
  for(i=0;i<meta.length;i++) segs += (meta[i].count-1);
  var g = fatGeometry(segs), n=0, a=[0,0,0], b=[0,0,0];
  for(i=0;i<meta.length;i++){
    var m=meta[i], s=m.start;
    for(var j=0;j<m.count-1;j++){
      unitVec(co[(s+j)*2]/100, co[(s+j)*2+1]/100, a);
      unitVec(co[(s+j+1)*2]/100, co[(s+j+1)*2+1]/100, b);
      pushSegment(g, n++, [a[0]*radius,a[1]*radius,a[2]*radius],
                          [b[0]*radius,b[1]*radius,b[2]*radius]);
    }
  }
  g.setDrawRange(0, n*6); g.computeBoundingSphere();
  return g;
}
var ADMIN_W = 1.15, COUNTRY_W = 2.6;
var adminLine = null, countryLine = null;
function addCountryBorders(bytes){
  BORD.country = decodeLines(bytes);
  countryLine = new THREE.Mesh(fatFromSet(BORD.country, 1.0019), fatMaterial(0x406170, 0.95, COUNTRY_W));
  countryLine.frustumCulled = false; countryLine.renderOrder = 3; globe.add(countryLine);
  applyBorderMode();
}
function addAdminBorders(bytes){
  BORD.admin = decodeLines(bytes);
  adminLine = new THREE.Mesh(fatFromSet(BORD.admin, 1.0017), fatMaterial(0x6A7F8A, 0.92, ADMIN_W));
  adminLine.frustumCulled = false; adminLine.renderOrder = 2; globe.add(adminLine);
  applyBorderMode();
}
function addCoastBorders(bytes){
  BORD.coast = decodeLines(bytes);
  coastLine = buildThin(BORD.coast, 0x93A7B0, 0.55, 1.0015);
  applyBorderMode();
}

/* ---- outline layers: country (under), guess, answer (on top) ---- */
function makeHL(color, width, order, maxSeg){
  var geo = fatGeometry(maxSeg);
  var mat = fatMaterial(color, 0.95, width);
  var mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = order; mesh.visible = false;
  globe.add(mesh);
  return { geo:geo, mat:mat, mesh:mesh, max:maxSeg };
}
var HL = {
  country: makeHL(0x878481, 3.0, 6, 40000),
  guess:   makeHL(0xFF6600, 3.4, 7, 30000),
  answer:  makeHL(0x0137FF, 3.4, 8, 30000),
  other:   makeHL(0xAA0FFF, 2.0, 7, 30000)
};
function outline(which, ids, cLon, cLat){
  var H = HL[which], set = {}, k;
  for(k=0;k<ids.length;k++) set[ids[k]] = 1;
  var n = 0, a=[0,0,0], b=[0,0,0], R = 1.0034 + (which==='country' ? -0.0012 : 0);
  var cv=[0,0,0], maxAng = 0;
  if(cLon !== undefined) unitVec(cLon, cLat, cv);
  ['coast','admin','country'].forEach(function(key){
    var S = BORD[key]; if(!S) return;
    var meta = S.meta, co = S.coords;
    for(var i=0;i<meta.length;i++){
      var m = meta[i];
      var in1 = !!set[m.o1], in2 = !!set[m.o2];
      // only the outline of the highlighted set: an edge with the set on both
      // sides is internal, and stays at its normal map weight
      if(in1 === in2) continue;
      var s = m.start;
      for(var j=0;j<m.count-1 && n < H.max;j++){
        unitVec(co[(s+j)*2]/100, co[(s+j)*2+1]/100, a);
        unitVec(co[(s+j+1)*2]/100, co[(s+j+1)*2+1]/100, b);
        if(cLon !== undefined){
          var dt = Math.acos(Math.max(-1,Math.min(1, a[0]*cv[0]+a[1]*cv[1]+a[2]*cv[2])));
          if(dt > maxAng) maxAng = dt;
        }
        pushSegment(H.geo, n++, [a[0]*R,a[1]*R,a[2]*R], [b[0]*R,b[1]*R,b[2]*R]);
      }
    }
  });
  ['position','aOther','aSide','aDir','aW'].forEach(function(k2){ H.geo.attributes[k2].needsUpdate = true; });
  H.geo.setDrawRange(0, n*6);
  H.mesh.visible = n > 0;
  return maxAng;
}
function clearOutlines(){ for(var k in HL) HL[k].mesh.visible = false; }

function distForAngle(th){
  var a = (BASE_FOV*D2R/2) * 0.80;
  th = Math.max(0.045, Math.min(1.24, th));
  var d = Math.cos(th) + Math.sin(th)/Math.tan(a);
  return Math.max(MIN_D+0.02, Math.min(MAX_D, d));
}

/* ---- markers + arc ---- */
function makeMarker(color){
  var g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.0075,16,12),
        new THREE.MeshBasicMaterial({color:color})));
  g.add(new THREE.Mesh(new THREE.RingGeometry(0.014,0.0185,32),
        new THREE.MeshBasicMaterial({color:color, transparent:true, opacity:0.85, side:THREE.DoubleSide})));
  g.visible = false; globe.add(g);
  return g;
}
var mkTarget = makeMarker(0x0137FF), mkGuess = makeMarker(0xFF6600);
function placeMarker(m, lon, lat){
  var v=[0,0,0]; unitVec(lon,lat,v);
  m.position.set(v[0]*1.006, v[1]*1.006, v[2]*1.006);
  m.lookAt(0,0,0); m.rotateY(Math.PI); m.visible = true;
}
var ARC_N = 128;
var arcGeo = fatGeometry(ARC_N);
var arc = new THREE.Mesh(arcGeo, fatMaterial(0xFF6600, 0.95, COUNTRY_W));
arc.frustumCulled = false; arc.renderOrder = 5; arc.visible = false; globe.add(arc);
function drawArc(lon1,lat1,lon2,lat2){
  var a=[0,0,0], b=[0,0,0]; unitVec(lon1,lat1,a); unitVec(lon2,lat2,b);
  var dot = Math.max(-1,Math.min(1, a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));
  var om = Math.acos(dot), R = 1.0058, pts = [], i;
  for(i=0;i<=ARC_N;i++){
    var t=i/ARC_N, s1, s2;
    if(om < 1e-4){ s1=1-t; s2=t; }
    else { s1=Math.sin((1-t)*om)/Math.sin(om); s2=Math.sin(t*om)/Math.sin(om); }
    var x=a[0]*s1+b[0]*s2, y=a[1]*s1+b[1]*s2, z=a[2]*s1+b[2]*s2;
    var L=Math.sqrt(x*x+y*y+z*z)||1;
    pts.push([x/L*R, y/L*R, z/L*R]);
  }
  for(i=0;i<ARC_N;i++) pushSegment(arcGeo, i, pts[i], pts[i+1]);
  ['position','aOther','aSide','aDir','aW'].forEach(function(k){ arcGeo.attributes[k].needsUpdate = true; });
  arcGeo.setDrawRange(0, ARC_N*6);
  arc.visible = true;
}
/* ---- journey arrows ----
   Up to three great-circle paths from the anchor place to the others, with a
   solid arrowhead at whichever end the person was travelling towards. The head
   is not a separate mesh: the line simply flares and then tapers to nothing over
   its last few segments, which the per-vertex width attribute gives us free. */
var JN = 96, HEAD_DEG = 2.6, HEAD_W = 3.4, ARROW_W = 2.6;
var arrows = [];
for(var _ai=0; _ai<3; _ai++){
  var _g = fatGeometry(JN);
  var _m = new THREE.Mesh(_g, fatMaterial(0xAA0FFF, 0.95, ARROW_W));
  _m.frustumCulled = false; _m.renderOrder = 6; _m.visible = false;
  globe.add(_m); arrows.push({geo:_g, mesh:_m});
}
function slerpPts(a, b, n, R){
  var dot = Math.max(-1, Math.min(1, a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));
  var om = Math.acos(dot), pts = [], i;
  for(i=0;i<=n;i++){
    var t=i/n, s1, s2;
    if(om < 1e-4){ s1=1-t; s2=t; }
    else { s1=Math.sin((1-t)*om)/Math.sin(om); s2=Math.sin(t*om)/Math.sin(om); }
    var x=a[0]*s1+b[0]*s2, y=a[1]*s1+b[1]*s2, z=a[2]*s1+b[2]*s2;
    var L=Math.sqrt(x*x+y*y+z*z)||1;
    pts.push([x/L*R, y/L*R, z/L*R]);
  }
  return pts;
}
// width profile along the path: 1 for the shaft, flaring to a point at a head
function headProfile(i, n, h, headStart, headEnd){
  if(headStart && i <= h){
    var u = i/h;                          // 0 at the tip, 1 where the shaft starts
    return u < 0.02 ? 0 : HEAD_W*(1-u) + u;
  }
  if(headEnd && i >= n-h){
    var v = (n-i)/h;
    return v < 0.02 ? 0 : HEAD_W*(1-v) + v;
  }
  return 1;
}
function drawArrow(slot, lon1, lat1, lon2, lat2, mode){
  var A = arrows[slot]; if(!A) return;
  var a=[0,0,0], b=[0,0,0]; unitVec(lon1,lat1,a); unitVec(lon2,lat2,b);
  var pts = slerpPts(a, b, JN, 1.0062);
  var dot = Math.max(-1, Math.min(1, a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));
  var span = Math.acos(dot) * 180/Math.PI;               // arc length in degrees
  var h = Math.max(3, Math.min(Math.round(JN/4), Math.round(JN * HEAD_DEG / Math.max(span, 0.01))));
  var headStart = (mode === 'from' || mode === 'both');   // pointing back at place 1
  var headEnd   = (mode === 'to'   || mode === 'both');   // pointing at place 2
  for(var i=0;i<JN;i++){
    pushSegment(A.geo, i, pts[i], pts[i+1],
                headProfile(i, JN, h, headStart, headEnd),
                headProfile(i+1, JN, h, headStart, headEnd));
  }
  ['position','aOther','aSide','aDir','aW'].forEach(function(k){ A.geo.attributes[k].needsUpdate = true; });
  A.geo.setDrawRange(0, JN*6);
  A.mesh.visible = true;
}
function clearArrows(){ for(var i=0;i<arrows.length;i++) arrows[i].mesh.visible = false; }

function clearQuiz(){
  for(var i=0;i<4096;i++) maskData[i*4+3] = 0;
  maskTex.needsUpdate = true;
}
function paintQuiz(ids, slot){        // slot 1..4, 0 clears
  for(var i=0;i<ids.length;i++) maskData[ids[i]*4+3] = slot;
  maskTex.needsUpdate = true;
}
// the quiz keeps its marks between questions; only the transient channels reset
function clearRound(){
  mkTarget.visible = mkGuess.visible = arc.visible = false;
  clearArrows(); clearOutlines();
  for(var i=0;i<4096;i++){ maskData[i*4]=0; maskData[i*4+1]=0; maskData[i*4+2]=0; }
  maskTex.needsUpdate = true;
  uniforms.uSel.value = 0;
}
function clearMarks(){
  mkTarget.visible = mkGuess.visible = arc.visible = false;
  clearArrows();
  clearOutlines();
  uniforms.uSel.value = 0; uniforms.uShowMask.value = 0;
}

/* ---------------- camera ---------------- */
var qX = new THREE.Quaternion(), qY = new THREE.Quaternion();
var AX = new THREE.Vector3(1,0,0), AY = new THREE.Vector3(0,1,0);
function applyView(){
  qY.setFromAxisAngle(AY, (-90 - view.lon)*D2R);
  qX.setFromAxisAngle(AX, view.lat*D2R);
  globe.quaternion.copy(qX).multiply(qY);
  camera.position.set(0,0,view.dist);
  camera.lookAt(0,0,0);
  var s = Math.max(0.55, Math.min(1.6, (view.dist-1)*0.9));
  mkTarget.scale.setScalar(s); mkGuess.scale.setScalar(s);
  var zf = 0.72 + 0.28 * Math.max(0, Math.min(1, (3.2 - view.dist)/1.5));
  if(countryLine) countryLine.material.uniforms.uWidth.value = COUNTRY_W * zf;
  if(adminLine) adminLine.material.uniforms.uWidth.value = ADMIN_W * (0.62 + 0.38*(zf-0.72)/0.28);
  if(focusLine) focusLine.material.uniforms.uWidth.value = ADMIN_W * (0.62 + 0.38*(zf-0.72)/0.28);
}
var yShift = 0;
function setShift(f){ yShift = f; resize(); }
function resize(){
  var w=window.innerWidth, h=window.innerHeight;
  renderer.setSize(w,h,false);
  uRes.value.set(w,h);
  var a = w/h;
  camera.aspect = a;
  camera.fov = (a < 1) ? 2*Math.atan(Math.tan(BASE_FOV*D2R/2)/a)/D2R : BASE_FOV;
  if(yShift) camera.setViewOffset(w, h, 0, h*yShift, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

/* ---------------- detail tile atlas (hosted mode) ---------------- */
var ATL_N = 4, TILE = 512, Z = 3, COLS = 1<<(Z+1), ROWS = 1<<Z;
var atlCanvas = null, atlCtx = null, atlTex = null, atlC0 = -99, atlR0 = -99, atlBusy = false;
var tileCache = {};
function initAtlas(){
  atlCanvas = document.createElement('canvas');
  atlCanvas.width = atlCanvas.height = ATL_N*TILE;
  atlCtx = atlCanvas.getContext('2d');
  atlCtx.fillStyle = '#808080'; atlCtx.fillRect(0,0,atlCanvas.width,atlCanvas.height);
  atlTex = new THREE.Texture(atlCanvas);
  atlTex.minFilter = THREE.LinearFilter; atlTex.magFilter = THREE.LinearFilter;
  atlTex.generateMipmaps = false; atlTex.needsUpdate = true;
  uniforms.uAtlas.value = atlTex;
}
function tileUrl(c,r){ return A('detail/' + Z + '/' + c + '/' + r + '.jpg'); }
function updateAtlas(){
  if(!atlCanvas) return;
  if(view.dist > 2.45){ uniforms.uAtlasOn.value = 0; return; }
  if(atlBusy) return;
  var tw = 360/COLS, th = 180/ROWS;
  var c0 = Math.round((view.lon+180)/tw - ATL_N/2);
  var r0 = Math.round((90-view.lat)/th - ATL_N/2);
  c0 = Math.max(0, Math.min(COLS-ATL_N, c0));
  r0 = Math.max(0, Math.min(ROWS-ATL_N, r0));
  if(c0 === atlC0 && r0 === atlR0){ uniforms.uAtlasOn.value = 1; return; }
  atlBusy = true;
  var pending = [], k, c, r;
  for(k=0;k<ATL_N*ATL_N;k++){
    c = c0 + (k % ATL_N); r = r0 + Math.floor(k/ATL_N);
    (function(c,r,k){
      var key = c+'_'+r;
      if(tileCache[key]){ pending.push(Promise.resolve({img:tileCache[key],k:k})); return; }
      pending.push(new Promise(function(res){
        var im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = function(){ tileCache[key] = im; res({img:im,k:k}); };
        im.onerror = function(){ res({img:null,k:k}); };
        im.src = tileUrl(c,r);
      }));
    })(c,r,k);
  }
  Promise.all(pending).then(function(list){
    atlCtx.fillStyle = '#808080'; atlCtx.fillRect(0,0,atlCanvas.width,atlCanvas.height);
    list.forEach(function(t){
      if(!t.img) return;
      atlCtx.drawImage(t.img, (t.k % ATL_N)*TILE, Math.floor(t.k/ATL_N)*TILE, TILE, TILE);
    });
    atlTex.needsUpdate = true;
    atlC0 = c0; atlR0 = r0;
    uniforms.uAtlasRect.value.set(c0/COLS, 1 - (r0+ATL_N)/ROWS, ATL_N/COLS, ATL_N/ROWS);
    uniforms.uAtlasOn.value = 1;
    atlBusy = false;
  });
}

/* ---------------- loop ---------------- */
// how many degrees of globe one screen pixel is worth at the current zoom
function degPerPx(){
  var minDim = Math.min(window.innerWidth, window.innerHeight);
  return (view.dist - 1) * (2*Math.tan(BASE_FOV*D2R/2) * (180/Math.PI)) / minDim;
}
var pulseOn = false;
function setPulse(on){
  pulseOn = on;
  if(!on){ uniforms.uSelAmt.value = 0.45; uniforms.uAnsAmt.value = 0.22; uniforms.uOthAmt.value = 0.22; }
}
/* view.lon is never wrapped -- the idle spin and a long drag both push it well
   past +-180 -- so an absolute longitude has to be restated as the turn nearest
   where the camera already is. Without this, flying to a place at -170 from a
   view sitting at +190 unwinds a whole revolution: the globe spins wildly and
   only then settles. */
function aimLon(lon){
  var d = ((lon - view.lon + 180) % 360 + 360) % 360 - 180;
  return view.lon + d;
}
var idle = true, tPrev = 0, atlTick = 0;
function loop(now){
  requestAnimationFrame(loop);
  if(!tPrev) tPrev = now || 0;
  var dt = Math.min(0.25, ((now||0) - tPrev)/1000); tPrev = now || 0;
  var k = 1 - Math.exp(-dt * 10.5);
  if(idle) target.lon -= dt * 2.1;
  view.lon += (target.lon-view.lon)*k;
  view.lat += (target.lat-view.lat)*k;
  view.dist += (target.dist-view.dist)*k;
  applyView();
  if(pulseOn){
    var p = 0.225 + 0.075*Math.sin((now||0)*0.00314159);   // 15% .. 30%, ~2s
    uniforms.uSelAmt.value = p; uniforms.uAnsAmt.value = p; uniforms.uOthAmt.value = p;
  }
  if(!INLINE && (atlTick = (atlTick+1) % 20) === 0) updateAtlas();
  renderer.render(scene,camera);
}

/* ---------------- picking ---------------- */
var ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), lv = new THREE.Vector3();
function readId(px,py){ var d = idCtx.getImageData(px,py,1,1).data; return d[0] + d[1]*256; }
function lonLatAt(clientX, clientY){
  ndc.x = (clientX/window.innerWidth)*2 - 1;
  ndc.y = -(clientY/window.innerHeight)*2 + 1;
  ray.setFromCamera(ndc, camera);
  var hit = ray.intersectObject(sphere, false);
  if(!hit.length) return null;
  lv.copy(hit[0].point); globe.worldToLocal(lv); lv.normalize();
  return { lat: Math.asin(Math.max(-1,Math.min(1,lv.y)))/D2R,
           lon: Math.atan2(-lv.z, lv.x)/D2R };
}
function pickAt(clientX, clientY){
  if(!uniforms.uHasId.value) return null;
  ndc.x = (clientX/window.innerWidth)*2 - 1;
  ndc.y = -(clientY/window.innerHeight)*2 + 1;
  ray.setFromCamera(ndc, camera);
  var hit = ray.intersectObject(sphere, false);
  if(!hit.length) return null;
  lv.copy(hit[0].point); globe.worldToLocal(lv); lv.normalize();
  var lat = Math.asin(Math.max(-1,Math.min(1,lv.y)))/D2R;
  var lon = Math.atan2(-lv.z, lv.x)/D2R;
  var px = Math.floor(((lon+180)/360)*4096), py = Math.floor(((90-lat)/180)*2048);
  px = Math.max(0,Math.min(4095,px)); py = Math.max(0,Math.min(2047,py));
  var id = readId(px,py);
  if(!id){
    var rr = 14, x0=Math.max(0,px-rr), y0=Math.max(0,py-rr);
    var w=Math.min(4096,px+rr+1)-x0, h=Math.min(2048,py+rr+1)-y0;
    var d = idCtx.getImageData(x0,y0,w,h).data, best=1e9, bid=0;
    for(var yy=0;yy<h;yy++) for(var xx=0;xx<w;xx++){
      var o=(yy*w+xx)*4, v=d[o]+d[o+1]*256;
      if(v){ var dx=x0+xx-px, dy=y0+yy-py, dd=dx*dx+dy*dy; if(dd<best){best=dd; bid=v;} }
    }
    id = bid;
  }
  return id ? {id:id, lon:lon, lat:lat} : null;
}

window.__M__ = { GD:null, ASSETS:ASSETS, INLINE:INLINE, view:view, target:target,
  idle:function(v){idle=v;}, applyView:applyView, uniforms:uniforms, pickAt:pickAt,
  outline:outline, clearOutlines:clearOutlines, placeMarker:placeMarker, mkTarget:mkTarget, mkGuess:mkGuess,
  drawArc:drawArc, drawArrow:drawArrow, clearArrows:clearArrows,
  clearQuiz:clearQuiz, paintQuiz:paintQuiz, clearRound:clearRound, lonLatAt:lonLatAt,
  clearMarks:clearMarks, setShift:setShift, maskData:maskData,
  maskTex:maskTex, gcKm:gcKm, distForAngle:distForAngle, MIN_D:MIN_D, MAX_D:MAX_D,
  idCtx:idCtx, camera:camera, scene:scene, globe:globe,
  degPerPx:degPerPx, setPulse:setPulse, setBorderMode:setBorderMode, assetUrl:A, aimLon:aimLon,
  setStyle:setStyle, setFocusAdmin:setFocusAdmin, styleId:function(){ return styleId; } };

function mkTex(src, nearest){
  var t = new THREE.Texture(src);
  t.needsUpdate = true;
  t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  if(nearest) t.generateMipmaps = false;
  else t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
function loadImage(url){
  return new Promise(function(res, rej){
    var i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = function(){ res(i); }; i.onerror = rej; i.src = url;
  });
}

/* ---------------- globe styles ---------------- */
// how hard the shared relief layer is pushed: imagery that already carries its own
// shading needs far less than a flat cartographic fill
var STYLE_DETAIL = { 'default':0.85, 'nasa1':0.40, 'nasa2':0.40,
                     'natural':0.45, 'mgreen':0.70, 'mblue':0.70 };
var styleId = 'default', styleSeq = 0;
function styleFiles(id){
  if(id === 'default') return ['terrain-z1.jpg','terrain-z2.jpg'];
  return ['styles/'+id+'-z1.jpg', 'styles/'+id+'-z2.jpg'];
}
function setStyle(id, done){
  if(!STYLE_DETAIL[id]) id = 'default';
  styleId = id;
  uniforms.uDetailAmt.value = STYLE_DETAIL[id];
  var seq = ++styleSeq, f = styleFiles(id);
  if(INLINE){
    var src = (id === 'default') ? window.__TERRAIN__ : (window.__STYLES__ || {})[id];
    if(!src){ if(done) done(); return; }
    loadImage(src).then(function(im){
      if(seq !== styleSeq) return;
      uniforms.uTerrain.value = mkTex(im); if(done) done();
    });
    return;
  }
  loadImage(A(f[0])).then(function(im){
    if(seq !== styleSeq) return;
    uniforms.uTerrain.value = mkTex(im);
    if(done) done();
    return loadImage(A(f[1]));
  }).then(function(im){
    if(im && seq === styleSeq) uniforms.uTerrain.value = mkTex(im);
  })['catch'](function(){ if(done) done(); });
}

/* ---------------- boot ---------------- */
function startLoop(){ loop(0); }

if(INLINE){
  GD = JSON.parse(INLINE_EL.textContent);
  window.__M__.GD = GD;
  addCoastBorders(b64bytes(GD.borders.coast));
  addAdminBorders(b64bytes(GD.borders.admin));
  addCountryBorders(b64bytes(GD.borders.country));
  var need = 3, got = 0;
  function tick(){ if(++got === need){ startLoop(); window.__M__.onReady(); } }
  loadImage(window.__TERRAIN__).then(function(im){ uniforms.uTerrain.value = mkTex(im); tick(); });
  loadImage(window.__IDMAP__).then(function(im){
    idCtx.drawImage(im,0,0); uniforms.uId.value = mkTex(im, true); uniforms.uHasId.value = 1; tick();
  });
  loadImage(window.__DETAIL__).then(function(im){
    var src = im, maxT = renderer.capabilities.maxTextureSize;
    if(im.width > maxT){
      var c = document.createElement('canvas');
      c.width = Math.min(maxT,4096); c.height = c.width/2;
      c.getContext('2d').drawImage(im,0,0,c.width,c.height); src = c;
    }
    var t = mkTex(src); t.format = THREE.LuminanceFormat;
    uniforms.uDetail.value = t; uniforms.uDetailAmt.value = 0.85; tick();
  });
} else {
  initAtlas();
  uniforms.uAtlasOn.value = 0;
  var J = function(u){ return fetch(A(u)).then(function(r){ return r.json(); }); };
  var Bf = function(u){ return fetch(A(u)).then(function(r){ return r.arrayBuffer(); }); };
  Promise.all([ J('meta.json'), J('pool.json'), Bf('borders-country.bin'),
                loadImage(A('terrain-z1.jpg')) ])
  .then(function(a){
    GD = a[0]; GD.pool = a[1];
    window.__M__.GD = GD;
    addCountryBorders(new Uint8Array(a[2]));
    uniforms.uTerrain.value = mkTex(a[3]);
    startLoop();
    window.__M__.onReady();
    // everything below arrives while the player is reading the intro
    loadImage(A('terrain-z2.jpg')).then(function(im){ uniforms.uTerrain.value = mkTex(im); });
    Bf('borders-admin.bin').then(function(b){ addAdminBorders(new Uint8Array(b)); });
    Bf('borders-coast.bin').then(function(b){ addCoastBorders(new Uint8Array(b)); });
    loadImage(A('idmap.png')).then(function(im){
      idCtx.drawImage(im,0,0); uniforms.uId.value = mkTex(im, true); uniforms.uHasId.value = 1;
      if(window.__M__.onPickReady) window.__M__.onPickReady();
    });
  })['catch'](function(e){
    if(window.__M__.onLoadError) window.__M__.onLoadError();
    console.error(e);
  });
}
})();
