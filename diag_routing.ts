import { instrumentationAmpNir } from "./serializer/fixtures"
import { nirToCircuitJson } from "./serializer/serializer"

const nir: any = instrumentationAmpNir

// ---- replicate constants from serializer.ts ----
const PIN_OFFSET_HALF_SIDE = 5
const TRACE_WIRE_STUB_MM = 2
const LAYOUT_SPACING_MM = 16
const LAYOUT_INIT_TEMP = 9
const LAYOUT_ITERATIONS = 700
const LAYOUT_GRAVITY = 0.05

const SYMBOL_DISCRETE_W = 6, SYMBOL_DISCRETE_H = 2
const SYMBOL_IC_W = 10
function isIC(t: string) {
  return ["instrumentation_amp","voltage_reference","ldo_regulator","digital_potentiometer","mcu","opamp","logic"].includes(t)
}
function inferPinCount(fp: string) {
  switch (fp) {
    case "MSOP-8": return 8
    case "MSOP-10": return 10
    case "SOT-23-5": case "TSOT-23-5": return 5
    case "SOT-23": return 3
    default: return 2
  }
}
function refKind(ref: string){const m=String(ref).match(/^[A-Z]+/i);return m?m[0].toUpperCase():"?"}
function bodySizeFor(t: string, fp: string) {
  if (isIC(t)) {
    const extra = Math.max(0, Math.ceil(inferPinCount(fp)/2) - 4)
    return { width: SYMBOL_IC_W, height: SYMBOL_DISCRETE_H + 6 + extra }
  }
  return { width: SYMBOL_DISCRETE_W, height: SYMBOL_DISCRETE_H }
}
function inferPinOffset(kind: string, ic: boolean, pinCount: number, pinNumber: any) {
  const n = typeof pinNumber === "number" ? pinNumber : parseInt(String(pinNumber),10)
  if (Number.isNaN(n)) return { dx:0, dy:0 }
  if (!ic) return { dx: n===1 ? -PIN_OFFSET_HALF_SIDE : +PIN_OFFSET_HALF_SIDE, dy:0 }
  const bodyH = 6 + Math.max(0, Math.ceil(pinCount/2)-4)
  const half = Math.ceil(pinCount/2)
  const left = (n%2)===1
  const si = left ? Math.floor((n-1)/2) : Math.floor((n-2)/2)
  const sc = left ? half : (pinCount-half)
  const vs = bodyH*0.8
  const y = sc>1 ? (si/(sc-1))*vs - vs/2 : 0
  return { dx: left ? -PIN_OFFSET_HALF_SIDE : +PIN_OFFSET_HALF_SIDE, dy:y }
}

// ---- replicate computeLayout (force-directed) ----
function computeLayout(comps: any[], netlist: any[], constraints: any[]) {
  const refsAll = comps.map((c:any)=>c.ref)
  const refSet = new Set(refsAll)
  const externals: string[] = []
  for (const net of netlist) for (const conn of net.connections) {
    if (!refSet.has(conn.ref) && !externals.includes(conn.ref)) externals.push(conn.ref)
  }
  const nodes = [...refsAll, ...externals]
  const nodeIdx: any = {}
  nodes.forEach((r:string,i:number)=>nodeIdx[r]=i)
  const N = nodes.length
  const pinned: any = {}
  for (const c of comps) {
    const p = c.position
    if (p && typeof p.x_mm==="number" && typeof p.y_mm==="number") pinned[nodeIdx[c.ref]] = {x:p.x_mm,y:p.y_mm}
  }
  const COLS = Math.ceil(Math.sqrt(N))
  let pos = nodes.map((_:any,i:number)=>({
    x:(i%COLS)*LAYOUT_SPACING_MM - (COLS*LAYOUT_SPACING_MM)/2,
    y:Math.floor(i/COLS)*LAYOUT_SPACING_MM - (COLS*LAYOUT_SPACING_MM)/2,
  }))
  const K = LAYOUT_SPACING_MM
  interface Edge {i:number;j:number;w:number;target:number}
  const edges: Edge[] = []
  for (const net of netlist) {
    const members = net.connections.map((c:any)=>c.ref).filter((r:string)=>nodeIdx[r]!==undefined)
    const m = members.length
    if (m<2) continue
    const w = 1/(m-1)
    for (let a=0;a<m;a++) for (let b=a+1;b<m;b++) edges.push({i:nodeIdx[members[a]],j:nodeIdx[members[b]],w,target:K})
  }
  for (const con of constraints) {
    if (con.constraint_type!=="proximity") continue
    const ri=nodeIdx[con.ref], rj=nodeIdx[con.relative_to]
    if (ri===undefined||rj===undefined) continue
    const w = con.hard?9:3
    const target = Math.min(con.max_distance_mm??K, K*0.85)
    edges.push({i:ri,j:rj,w,target})
  }
  let temp = LAYOUT_INIT_TEMP
  for (let it=0;it<LAYOUT_ITERATIONS;it++) {
    const disp = nodes.map(()=>({x:0,y:0}))
    for (let a=0;a<N;a++) for (let b=a+1;b<N;b++) {
      let dx=pos[a].x-pos[b].x, dy=pos[a].y-pos[b].y
      const d=Math.hypot(dx,dy)||0.01
      const f=(K*K)/d, ux=dx/d, uy=dy/d
      disp[a].x+=ux*f; disp[a].y+=uy*f; disp[b].x-=ux*f; disp[b].y-=uy*f
    }
    for (const e of edges) {
      let dx=pos[e.i].x-pos[e.j].x, dy=pos[e.i].y-pos[e.j].y
      const d=Math.hypot(dx,dy)||0.01
      const f=(d-e.target)*e.w, ux=dx/d, uy=dy/d
      disp[e.i].x-=ux*f; disp[e.i].y-=uy*f; disp[e.j].x+=ux*f; disp[e.j].y+=uy*f
    }
    for (let a=0;a<N;a++){disp[a].x+=-pos[a].x*LAYOUT_GRAVITY; disp[a].y+=-pos[a].y*LAYOUT_GRAVITY}
    for (let a=0;a<N;a++){
      if (a in pinned){pos[a]={...pinned[a]};continue}
      const d=Math.hypot(disp[a].x,disp[a].y)||0.01
      pos[a]={x:pos[a].x+(disp[a].x/d)*Math.min(d,temp), y:pos[a].y+(disp[a].y/d)*Math.min(d,temp)}
    }
    temp = LAYOUT_INIT_TEMP*(1-it/LAYOUT_ITERATIONS)+0.2
  }
  // center
  let mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9
  for(const p of pos){mnx=Math.min(mnx,p.x);mxx=Math.max(mxx,p.x);mny=Math.min(mny,p.y);mxy=Math.max(mxy,p.y)}
  const cx=(mnx+mxx)/2, cy=(mny+mxy)/2
  pos = pos.map((p:any)=>({x:p.x-cx,y:p.y-cy}))
  const layout: any = {}
  nodes.forEach((r:string,i:number)=>layout[r]={x:pos[i].x,y:pos[i].y,rot:0})
  return layout
}

// ---- replicate buildPinMap ----
const comps = nir.components
const layout = computeLayout(comps, nir.netlist, nir.placement_constraints)
const centerOf = (ref:string)=> layout[ref]
function buildPinMap() {
  const map: any = {}
  for (const net of nir.netlist) {
    for (const conn of net.connections) {
      const c = comps.find((c:any)=>c.ref===conn.ref)
      if (!c && !(conn.ref in layout)) continue
      const ic = c ? isIC(c.component_type) : false
      const pc = c ? inferPinCount(c.footprint) : 2
      const off = inferPinOffset(refKind(conn.ref), ic, pc, conn.pin_number)
      if (layout[conn.ref]) map[`${conn.ref}#${conn.pin_number}`] = {
        ref: conn.ref, pin_name: conn.pin_name, pin_number: conn.pin_number,
        x: layout[conn.ref].x + off.dx, y: layout[conn.ref].y + off.dy,
      }
    }
  }
  return map
}
const pinMap = buildPinMap()

// ---- replicate the NEW router: per-net free-space hub + obstacle-aware L-bend ----
interface Seg { net:string; ax:number; ay:number; bx:number; by:number; x1:number;y1:number;x2:number;y2:number; refA:string; refB:string }
function bodySizeForRouter(t:string, fp:string){ if(isIC(t)){const e=Math.max(0,Math.ceil(inferPinCount(fp)/2)-4);return{width:SYMBOL_IC_W,height:SYMBOL_DISCRETE_H+6+e}} return{width:SYMBOL_DISCRETE_W,height:SYMBOL_DISCRETE_H} }
const bodies:any = {}
for (const c of comps){ const s=bodySizeForRouter(c.component_type,c.footprint); const p=layout[c.ref]; if(!p)continue; bodies[c.ref]={x0:p.x-s.width/2,x1:p.x+s.width/2,y0:p.y-s.height/2,y1:p.y+s.height/2} }
function pointInAnyBody(pt:any){ for(const r in bodies){const b=bodies[r]; if(pt.x>b.x0&&pt.x<b.x1&&pt.y>b.y0&&pt.y<b.y1)return true} return false }
function segSeg(x1:number,y1:number,x2:number,y2:number,x3:number,y3:number,x4:number,y4:number){const d=(x2-x1)*(y4-y3)-(y2-y1)*(x4-x3);if(d===0)return false;const t=((x3-x1)*(y4-y3)-(y3-y1)*(x4-x3))/d;const u=((x3-x1)*(y2-y1)-(y3-y1)*(x2-x1))/d;return t>=0&&t<=1&&u>=0&&u<=1}
function segCrossRect5(x1:number,y1:number,x2:number,y2:number,r:any){const eps=0.01;const rx0=r.x0+eps,rx1=r.x1-eps,ry0=r.y0+eps,ry1=r.y1-eps;if(rx1<=rx0||ry1<=ry0)return false;const inside=(x:number,y:number)=>x>=rx0&&x<=rx1&&y>=ry0&&y<=ry1;if(inside(x1,y1)||inside(x2,y2))return true;const ed:any=[[rx0,ry0,rx1,ry0],[rx1,ry0,rx1,ry1],[rx1,ry1,rx0,ry1],[rx0,ry1,rx0,ry0]];for(const e of ed)if(segSeg(x1,y1,x2,y2,e[0],e[1],e[2],e[3]))return true;return false}
function segCrossingsBodies(a:any,b:any,excl:string){let c=0;for(const r in bodies){if(r===excl)continue;if(segCrossRect5(a.x,a.y,b.x,b.y,bodies[r]))c++}return c}
function chooseSpokePath(p:any,h:any,placed:any[]){const variants=[[{x:p.x,y:p.y},{x:h.x,y:p.y},{x:h.x,y:h.y}],[{x:p.x,y:p.y},{x:p.x,y:h.y},{x:h.x,y:h.y}]];let best:any=null;for(const path of variants){let bc=0,wc=0;for(let s=0;s<path.length-1;s++){const a=path[s],b=path[s+1];bc+=segCrossingsBodies(a,b,p.ref);for(const w of placed)if(segSeg(a.x,a.y,b.x,b.y,w.x1,w.y1,w.x2,w.y2))wc++}const len=Math.abs(h.x-p.x)+Math.abs(h.y-p.y);const score=bc*1000+wc*10+len;if(!best||score<best.bodyCross*1000+best.wireCross*10+best.len)best={path,bodyCross:bc,wireCross:wc,len}}return best}
function computeNetHub(pins:any[],placed:any[]){const cx=pins.reduce((s:number,p:any)=>s+p.x,0)/pins.length;const cy=pins.reduce((s:number,p:any)=>s+p.y,0)/pins.length;const cands:any[]=[{x:cx,y:cy}];for(let dx=-28;dx<=28;dx+=4)for(let dy=-28;dy<=28;dy+=4){if(dx===0&&dy===0)continue;cands.push({x:cx+dx,y:cy+dy})};let best:any=null,bs=1e9,bl=1e9;for(const h of cands){if(pointInAnyBody(h))continue;let sc=0,tl=0;for(const p of pins){const r=chooseSpokePath(p,h,placed);sc+=r.bodyCross*1000+r.wireCross*10;tl+=r.len}if(sc<bs||(sc===bs&&tl<bl)){bs=sc;bl=tl;best=h}}return best??{x:cx,y:cy}}
const RAIL = new Set(["GND","VBAT","VBAT_FILTERED","VCC_ANALOG","VREF"])
function isRail(net:any){ return net.net_type==="power"||net.net_type==="ground"||RAIL.has(net.net_name) }
const allSegs: Seg[] = []
const placedWires:any[] = []
for (const net of [...nir.netlist].sort((a:any,b:any)=>b.connections.length-a.connections.length)) {
  if (isRail(net)) continue // rail nets become net labels, not wires (mirror serializer)
  const pins:any[] = []
  for (const conn of net.connections) {
    const p = pinMap[`${conn.ref}#${conn.pin_number}`]
    if (p) pins.push({...p, ref: conn.ref})
  }
  if (pins.length<2) continue
  const hub = computeNetHub(pins, placedWires)
  pins.forEach((pin:any,i:number)=>{
    const chosen = chooseSpokePath(pin, hub, placedWires)
    for (let s=0;s<chosen.path.length-1;s++){
      const a=chosen.path[s], b=chosen.path[s+1]
      if (a.x===b.x&&a.y===b.y) continue
      allSegs.push({net:net.net_name, ax:pin.x, ay:pin.y, bx:hub.x, by:hub.y, x1:a.x, y1:a.y, x2:b.x, y2:b.y, refA:pin.ref, refB:"__hub__"})
      placedWires.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y})
    }
  })
}

// sanity: compare to actual serializer blue segment count
const cj:any[] = nirToCircuitJson(nir)
const actualBlue = cj.filter((e:any)=>e.type==="schematic_line" && e.color==="#1f6feb").length
console.log(`Replicated routed segments: ${allSegs.length}  | actual serializer blue segments: ${actualBlue}  (match: ${allSegs.length===actualBlue})`)

// ---- component body boxes ----
const body: any = {}
for (const c of comps) {
  const s = bodySizeFor(c.component_type, c.footprint)
  const p = layout[c.ref]
  if (!p) continue
  body[c.ref] = { x0:p.x-s.width/2, x1:p.x+s.width/2, y0:p.y-s.height/2, y1:p.y+s.height/2, cx:p.x, cy:p.y }
}
const EPS = 0.001
function segRectCross(s:Seg, r:any): boolean {
  // segment (x1,y1)-(x2,y2) vs rect [x0,x1]x[y0,y1]; exclude grazing within EPS
  const {x1,y1,x2,y2} = s
  const rx0=r.x0+EPS, rx1=r.x1-EPS, ry0=r.y0+EPS, ry1=r.y1-EPS
  if (rx1<=rx0 || ry1<=ry0) return false
  // endpoint inside?
  const inside=(x:number,y:number)=> x>=rx0&&x<=rx1&&y>=ry0&&y<=ry1
  if (inside(x1,y1)||inside(x2,y2)) return true
  // intersect any of 4 edges
  const edges=[[rx0,ry0,rx1,ry0],[rx1,ry0,rx1,ry1],[rx1,ry1,rx0,ry1],[rx0,ry1,rx0,ry0]]
  for (const [ex1,ey1,ex2,ey2] of edges) {
    if (segSeg(x1,y1,x2,y2,ex1,ey1,ex2,ey2)) return true
  }
  return false
}
function segSeg(x1:number,y1:number,x2:number,y2:number,x3:number,y3:number,x4:number,y4:number): boolean {
  const d=(x2-x1)*(y4-y3)-(y2-y1)*(x4-x3)
  if (d===0) return false
  const t=((x3-x1)*(y4-y3)-(y3-y1)*(x4-x3))/d
  const u=((x3-x1)*(y2-y1)-(y3-y1)*(x2-x1))/d
  return t>=0&&t<=1&&u>=0&&u<=1
}

console.log("\n=== CHECK 1: body-crossing (segment vs OTHER component bodies) ===")
const cluster = new Set(["U1","R3","R4","C3","C4","D1"])
let crossFail=0
for (const s of allSegs) {
  for (const ref in body) {
    if (ref===s.refA || ref===s.refB) continue
    if (segRectCross(s, body[ref])) {
      const inCluster = cluster.has(s.refA)||cluster.has(s.refB)||cluster.has(ref)
      console.log(`  CROSS: net=${s.net} seg(${s.x1.toFixed(1)},${s.y1.toFixed(1)})->(${s.x2.toFixed(1)},${s.y2.toFixed(1)}) crosses body of ${ref}  [input-filter-cluster=${inCluster}]`)
      crossFail++
    }
  }
}
console.log(crossFail===0 ? "  PASS: no body crossings" : `  FAIL: ${crossFail} body-crossing segment(s)`)

console.log("\n=== CHECK 2: non-orthogonal endpoints + L-bend sanity ===")
let nonOrth=0, nonAxis=0
for (const s of allSegs) {
  if (s.ax!==s.bx && s.ay!==s.by) nonOrth++
  if (!(s.x1===s.x2 || s.y1===s.y2)) nonAxis++ // every emitted segment must be axis-aligned
}
console.log(`  non-orthogonal hub-spoke pairs: ${nonOrth} / ${allSegs.length} segments`)
console.log(`  non-axis-aligned emitted segments: ${nonAxis} (should be 0 -> single clean L-bend, no diagonals)`)
console.log(nonAxis===0 ? "  PASS: all segments axis-aligned (clean L-bend)" : "  FAIL: diagonal segments present")

console.log("\n=== CHECK 3: wire-wire overlap / crossing ===")
let wwCross=0, wwOverlap=0
for (let i=0;i<allSegs.length;i++) for (let j=i+1;j<allSegs.length;j++) {
  const a=allSegs[i], b=allSegs[j]
  if (a.net===b.net) continue // same net overlapping is fine
  if (segSeg(a.x1,a.y1,a.x2,a.y2,b.x1,b.y1,b.x2,b.y2)) {
    // distinguish crossing vs collinear overlap
    const aH = a.y1===a.y2, bH=b.y1===b.y2
    if (aH===bH) { wwOverlap++; console.log(`  OVERLAP: net ${a.net} & ${b.net} collinear segs overlap`); }
    else { wwCross++; const inC=(cluster.has(a.refA)||cluster.has(a.refB)||cluster.has(b.refA)||cluster.has(b.refB)); console.log(`  CROSS: net ${a.net} & ${b.net} cross [cluster=${inC}]`); }
  }
}
console.log(wwCross===0&&wwOverlap===0 ? "  PASS: no wire-wire crossings/overlaps between different nets" : `  FAIL: ${wwCross} crosses, ${wwOverlap} overlaps`)

console.log("\n=== CHECK 4: spacing sufficiency (min body-edge gap between any two components) ===")
let minGap=1e9, minPair=""
const refs=Object.keys(body)
for (let i=0;i<refs.length;i++) for (let j=i+1;j<refs.length;j++) {
  const A=body[refs[i]], B=body[refs[j]]
  const dx = Math.max(A.x0-B.x1, B.x0-A.x1)
  const dy = Math.max(A.y0-B.y1, B.y0-A.y1)
  const gap = Math.max(dx,dy) // 0 if overlapping
  if (gap<minGap){minGap=gap;minPair=`${refs[i]}-${refs[j]}`}
}
const CHANNEL = TRACE_WIRE_STUB_MM*2 + 2 // 6mm: room for a 2mm stub each side + trace
console.log(`  closest pair: ${minPair}  gap=${minGap.toFixed(2)}mm  (channel threshold ${CHANNEL}mm)`)
console.log(minGap>=CHANNEL ? "  PASS: closest bodies leave a routing channel" : `  FAIL: ${minPair} too close for a routing channel`)

console.log("\n=== CHECK 5: power/ground rails emit net labels, not wires ===")
// Verify against the ACTUAL serializer output (not the replication): every
// rail net must produce schematic_net_label elements (one per pin) and must
// NOT contribute any blue wire segment.
const actualCj:any[] = nirToCircuitJson(nir)
const actualLabels = actualCj.filter((e:any)=>e.type==="schematic_net_label")
let labelFail=0
let totalExpected=0
for (const net of nir.netlist) {
  if (!isRail(net)) continue
  const expected = net.connections.length
  totalExpected += expected
  const got = actualLabels.filter((l:any)=>l.source_net_id===`net_${net.net_name}`).length
  if (got !== expected) {
    console.log(`  FAIL: net ${net.net_name} expected ${expected} net labels, got ${got}`)
    labelFail++
  }
}
// Rail nets must not emit blue wire segments: the real blue count must equal
// the replicated (rail-excluded) segment count.
const actualBlueReal = actualCj.filter((e:any)=>e.type==="schematic_line" && e.color==="#1f6feb").length
if (actualBlueReal !== allSegs.length) {
  console.log(`  FAIL: actual blue wire segments ${actualBlue} != routed (non-rail) segments ${allSegs.length}`)
  labelFail++
}
console.log(`  rail net labels emitted: ${actualLabels.length} (expected ${totalExpected})`)
console.log(labelFail===0 ? "  PASS: rails emit net labels, no wire segments" : `  FAIL: ${labelFail} rail-label problem(s)`)
