import { useState, useMemo, useCallback, useRef, useEffect } from "react";

/* ─── Design tokens ─────────────────────────────────────────── */
const T = {
  bg: "#111317",
  panel: "#181B21",
  panel2: "#1E222A",
  line: "#2A2F39",
  grid: "#232833",
  gridMajor: "#2E3542",
  board: "#1B2027",
  boardEdge: "#3A4252",
  text: "#E8EAED",
  dim: "#8B93A1",
  faint: "#5A6270",
  accent: "#4FD1A5",
  accentDim: "#2E7D63",
  amber: "#F0B35B",
  red: "#E5636B",
  blue: "#5BA8F0",
};
const mono = "'SF Mono','JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";
const sans = "'Inter',system-ui,sans-serif";

/* ─── Engineering constants ─────────────────────────────────── */
const LEG_KG = 500;    // assumed capacity per leg (simplified)
const LEG_SIZE = 120;  // leg diameter (mm)
const LEG_H = 100;     // leg height (mm)
const SNAP = 25;
const MARGIN = LEG_SIZE / 2 + 20;
// board must fit within standard particle board sheet 2,440 × 1,220 mm
const MIN_DIM = 400, MAX_W = 2440, MAX_D = 1220;

/* leg layout presets: 4 / 5 / 6 / 7 / 8 / 9 legs */
const PRESETS = {
  4: (w, d) => [
    [200, 200], [w - 200, 200], [200, d - 200], [w - 200, d - 200]],
  5: (w, d) => [
    [200, 200], [w - 200, 200], [w / 2, d / 2], [200, d - 200], [w - 200, d - 200]],
  6: (w, d) => [
    [200, 200], [w / 2, 200], [w - 200, 200],
    [200, d - 200], [w / 2, d - 200], [w - 200, d - 200]],
  7: (w, d) => [
    [200, 200], [w / 2, 200], [w - 200, 200],
    [w / 2, d / 2],
    [200, d - 200], [w / 2, d - 200], [w - 200, d - 200]],
  8: (w, d) => [
    [200, 200], [w / 2, 200], [w - 200, 200],
    [200, d / 2], [w - 200, d / 2],
    [200, d - 200], [w / 2, d - 200], [w - 200, d - 200]],
  9: (w, d) => [
    [200, 200], [w / 2, 200], [w - 200, 200],
    [200, d / 2], [w / 2, d / 2], [w - 200, d / 2],
    [200, d - 200], [w / 2, d - 200], [w - 200, d - 200]],
};

/* build a one-page PDF that embeds a JPEG (no external libs) */
function jpegToPdfBlob(jpegBytes, pxW, pxH) {
  const wPt = 842; // A4-landscape width; height follows the sheet aspect
  const hPt = Math.round((wPt * pxH) / pxW);
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (dat) => { const b = typeof dat === "string" ? enc.encode(dat) : dat; chunks.push(b); offset += b.length; };
  push("%PDF-1.4\n");
  offsets.push(offset); push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets.push(offset); push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets.push(offset); push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n`);
  const content = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
  offsets.push(offset); push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  offsets.push(offset); push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push("\nendstream\nendobj\n");
  const xrefStart = offset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  offsets.forEach((o) => { xref += String(o).padStart(10, "0") + " 00000 n \n"; });
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  const total = new Uint8Array(offset);
  let p = 0;
  chunks.forEach((c) => { total.set(c, p); p += c.length; });
  return new Blob([total], { type: "application/pdf" });
}

let uid = 0;
const mkLeg = ([x, y]) => ({ id: ++uid, x, y });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => Number(v) || 0;
/* circular legs: hit / overlap tests by center distance */
const onLeg = (l, x, y) => Math.hypot(l.x - x, l.y - y) <= LEG_SIZE / 2;
const overlaps = (l, x, y) => Math.hypot(l.x - x, l.y - y) < LEG_SIZE;

/* ─── Small components ──────────────────────────────────────── */
function Gauge({ label, value, max, unit, color, note }) {
  const pct = clamp(max ? value / max : 0, 0, 1);
  return (
    <div className="rounded-xl p-4" style={{ background: T.panel2, border: `1px solid ${T.line}` }}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs tracking-widest uppercase" style={{ color: T.dim }}>{label}</span>
        <span className="text-xs" style={{ color: T.faint, fontFamily: mono }}>{note}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tabular-nums" style={{ color, fontFamily: mono }}>
          {value.toLocaleString()}
        </span>
        <span className="text-sm" style={{ color: T.dim }}>{unit}</span>
      </div>
      <div className="mt-3 h-1.5 w-full rounded-full overflow-hidden" style={{ background: T.line }}>
        <div className="h-full rounded-full" style={{
          width: `${pct * 100}%`,
          background: `linear-gradient(90deg, ${color}88, ${color})`,
          transition: "width .45s cubic-bezier(.22,1,.36,1)",
        }} />
      </div>
    </div>
  );
}

function Btn({ children, onClick, active, danger, primary }) {
  return (
    <button onClick={onClick}
      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
      style={{
        fontFamily: sans,
        background: primary ? T.accent : active ? T.accentDim : T.panel2,
        color: primary ? "#0C1712" : danger ? T.red : active ? "#DFFFF3" : T.text,
        border: `1px solid ${primary || active ? T.accent : T.line}`,
      }}>
      {children}
    </button>
  );
}

function NumField({ label, value, onChange, unit, w = "5.5rem" }) {
  return (
    <label className="flex items-center gap-2 text-xs" style={{ color: T.dim }}>
      <span className="whitespace-nowrap flex-1">{label}</span>
      <input
        type="number" inputMode="decimal" value={value} step="any"
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg px-2 py-1.5 text-right tabular-nums outline-none"
        style={{
          width: w, background: T.bg, color: T.text,
          border: `1px solid ${T.line}`, fontFamily: mono,
        }} />
      <span className="w-8">{unit}</span>
    </label>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: T.dim }}>
      <span>{label}</span>
      <input
        type="text" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg px-2.5 py-2 outline-none w-full"
        style={{ background: T.bg, color: T.text, border: `1px solid ${T.line}`, fontFamily: sans }} />
    </label>
  );
}

/* ═══════════════════ QUOTATION SHEET (English only) ═════════ */
function QuotationSheet({ w, d, t, legs, unitPrice, moq, shipping, customer, preparedBy }) {
  const svgRef = useRef(null);
  const n = legs.length;
  const H = LEG_H + t;
  const totalAmount = unitPrice * moq;

  const issue = new Date();
  const valid = new Date(issue);
  valid.setMonth(valid.getMonth() + 1);
  const fmtDate = (dt) => dt.toISOString().slice(0, 10);
  const qNo = `Q${fmtDate(issue).replace(/-/g, "")}-${String(n).padStart(2, "0")}`;

  const scale = 820 / Math.max(w, 820);
  const sScale = Math.max(scale, 0.5);
  const bvW = w * scale, bvD = d * scale;
  const svW = d * scale;
  const elevH = t * sScale + LEG_H * sScale;

  const PADX = 120, COLGAP = 170, GAP = 240;
  const tableW = 330;
  const rightCol = Math.max(tableW, svW + 130);
  const sheetW = Math.max(PADX * 2 + bvW + COLGAP + rightCol, 1620);
  const headerH = 360;
  const bvY = headerH;
  const rowY = bvY + bvD + GAP;
  const priceY = rowY + elevH + 150;
  const footerY = priceY + 4 * 58 + 120; // below the price table + notes
  const sheetH = footerY + 250;

  const ink = "#1B2430", faintInk = "#8A94A6", paper = "#FAFBFC";
  const dimStroke = { stroke: faintInk, strokeWidth: 1.5 };
  const F = { fontFamily: mono, fill: ink };

  const legXs = [...new Set(legs.map((l) => l.x))].sort((a, b) => a - b);
  const legYs = [...new Set(legs.map((l) => l.y))].sort((a, b) => a - b);

  const renderToCanvas = (cb) => {
    const svg = svgRef.current;
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = sheetW * 2; c.height = sheetH * 2;
      const ctx = c.getContext("2d");
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      cb(c);
    };
    img.src = url;
  };

  const saveBlob = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const downloadPNG = () => renderToCanvas((c) =>
    c.toBlob((png) => saveBlob(png, `FiX3RD_Quotation_${qNo}.png`))
  );

  const downloadPDF = () => renderToCanvas((c) =>
    c.toBlob(async (jpg) => {
      const bytes = new Uint8Array(await jpg.arrayBuffer());
      saveBlob(jpegToPdfBlob(bytes, c.width, c.height), `FiX3RD_Quotation_${qNo}.pdf`);
    }, "image/jpeg", 0.93)
  );

  const HDim = ({ x1, x2, y, text }) => (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} {...dimStroke} />
      <line x1={x1} y1={y - 7} x2={x1} y2={y + 7} {...dimStroke} />
      <line x1={x2} y1={y - 7} x2={x2} y2={y + 7} {...dimStroke} />
      <text x={(x1 + x2) / 2} y={y - 8} textAnchor="middle" fontSize="20" {...F}>{text}</text>
    </g>
  );
  const VDim = ({ y1, y2, x, text }) => (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} {...dimStroke} />
      <line x1={x - 7} y1={y1} x2={x + 7} y2={y1} {...dimStroke} />
      <line x1={x - 7} y1={y2} x2={x + 7} y2={y2} {...dimStroke} />
      <text x={x - 10} y={(y1 + y2) / 2} textAnchor="middle" fontSize="20" {...F}
        transform={`rotate(-90 ${x - 10} ${(y1 + y2) / 2})`}>{text}</text>
    </g>
  );

  const Elevation = ({ width, positions, title, showHeightDims }) => (
    <g>
      <rect x="0" y="0" width={width} height={t * sScale} fill="#EDEFF3" stroke={ink} strokeWidth="3" />
      {positions.map((p, i) => (
        <rect key={i}
          x={p * scale - (LEG_SIZE * scale) / 2} y={t * sScale}
          width={LEG_SIZE * scale} height={LEG_H * sScale}
          fill="#E7F3EE" stroke={ink} strokeWidth="2.5" />
      ))}
      <line x1={-25} y1={elevH} x2={width + 25} y2={elevH}
        stroke={faintInk} strokeWidth="1.5" strokeDasharray="12 8" />
      {showHeightDims && (
        <g>
          <VDim y1={0} y2={t * sScale} x={width + 45} text={`t=${t}`} />
          <VDim y1={t * sScale} y2={elevH} x={width + 95} text={`${LEG_H}`} />
        </g>
      )}
      <VDim y1={0} y2={elevH} x={-55} text={`H=${H}`} />
      <text x={width / 2} y={elevH + 45} textAnchor="middle" fontSize="19" fontWeight="600" {...F}>
        {title}
      </text>
    </g>
  );

  const priceRows = [
    ["DESCRIPTION", `3RD Pallet ${w.toLocaleString()} × ${d.toLocaleString()} × H${H} mm / ${n} legs`],
    ["MOQ", `${moq.toLocaleString()} pcs`],
    ["UNIT PRICE", `${unitPrice.toLocaleString()} THB / pc ${shipping ? "(incl. shipping)" : "(excl. shipping)"}`],
    ["TOTAL AMOUNT", `${totalAmount.toLocaleString()} THB`],
  ];

  return (
    <div>
      <svg ref={svgRef} viewBox={`0 0 ${sheetW} ${sheetH}`} className="w-full rounded-xl"
        style={{ background: paper, display: "block" }}>

        <rect x="14" y="14" width={sheetW - 28} height={sheetH - 28}
          fill="none" stroke={ink} strokeWidth="2.5" />

        {/* ── Header ── */}
        <text x={PADX} y={80} fontSize="44" fontWeight="700" letterSpacing="6" {...F}>QUOTATION</text>
        <text x={PADX} y={112} fontSize="17" fill={faintInk} fontFamily={mono}>
          3RD Pallet — Custom Layout · unit: mm
        </text>

        <g fontFamily={mono} fontSize="16" fill={ink}>
          <text x={sheetW - PADX} y={60} textAnchor="end">Quotation No: {qNo}</text>
          <text x={sheetW - PADX} y={88} textAnchor="end">Date of Issue: {fmtDate(issue)}</text>
          <text x={sheetW - PADX} y={116} textAnchor="end" fontWeight="700">Valid Until: {fmtDate(valid)}</text>
        </g>

        {/* ── Customer block ── */}
        <g transform={`translate(${PADX},150)`}>
          <line x1="0" y1="0" x2={sheetW - PADX * 2} y2="0" stroke={ink} strokeWidth="1.5" />
          <text x="0" y="34" fontSize="14" fill={faintInk} fontFamily={mono}>TO:</text>
          <text x="60" y="34" fontSize="22" fontWeight="700" {...F}>{customer.company || "—"}</text>
          <text x="60" y="62" fontSize="16" fill={ink} fontFamily={mono}>{customer.address || ""}</text>
          <text x="60" y="90" fontSize="16" fill={ink} fontFamily={mono}>
            {customer.contact ? `Attn: ${customer.contact}` : ""}
          </text>
          <line x1="0" y1="110" x2={sheetW - PADX * 2} y2="110" stroke={ink} strokeWidth="1.5" />
        </g>

        {/* ── BOTTOM VIEW ── */}
        <g transform={`translate(${PADX},${bvY})`}>
          <text x="0" y="-70" fontSize="15" fontFamily={mono} fill={faintInk} letterSpacing="2">TECHNICAL DRAWING</text>
          <rect x="0" y="0" width={bvW} height={bvD} fill="none" stroke={ink} strokeWidth="3" />
          {legs.map((l) => (
            <g key={l.id}>
              <circle cx={l.x * scale} cy={l.y * scale} r={(LEG_SIZE * scale) / 2}
                fill="#E7F3EE" stroke={ink} strokeWidth="2" />
              <line x1={l.x * scale - 14} y1={l.y * scale} x2={l.x * scale + 14} y2={l.y * scale} stroke={ink} strokeWidth="1.5" />
              <line x1={l.x * scale} y1={l.y * scale - 14} x2={l.x * scale} y2={l.y * scale + 14} stroke={ink} strokeWidth="1.5" />
            </g>
          ))}
          <HDim x1={0} x2={bvW} y={-30} text={`${w.toLocaleString()}`} />
          <VDim y1={0} y2={bvD} x={-30} text={`${d.toLocaleString()}`} />

          {/* leg position chain dims — X (edge → leg → … → edge) */}
          {(() => {
            const pts = [0, ...legXs, w];
            return pts.slice(0, -1).map((p, i) => {
              const a = p * scale, b = pts[i + 1] * scale;
              const mm = pts[i + 1] - p;
              if (mm <= 0) return null;
              const fs = b - a < 75 ? 13 : 17;
              return (
                <g key={"cx" + i}>
                  <line x1={a} y1={bvD + 45} x2={b} y2={bvD + 45} {...dimStroke} />
                  <line x1={a} y1={bvD + 38} x2={a} y2={bvD + 52} {...dimStroke} />
                  <line x1={b} y1={bvD + 38} x2={b} y2={bvD + 52} {...dimStroke} />
                  <text x={(a + b) / 2} y={bvD + 38} textAnchor="middle" fontSize={fs} {...F}>{mm}</text>
                </g>
              );
            });
          })()}
          {/* extension lines from leg centers down to the X chain */}
          {legXs.map((x, i) => (
            <line key={"ex" + i} x1={x * scale} y1={bvD} x2={x * scale} y2={bvD + 52}
              stroke={faintInk} strokeWidth="1" strokeDasharray="4 4" />
          ))}

          {/* leg position chain dims — Y */}
          {(() => {
            const pts = [0, ...legYs, d];
            return pts.slice(0, -1).map((p, i) => {
              const a = p * scale, b = pts[i + 1] * scale;
              const mm = pts[i + 1] - p;
              if (mm <= 0) return null;
              const fs = b - a < 75 ? 13 : 17;
              return (
                <g key={"cy" + i}>
                  <line x1={bvW + 45} y1={a} x2={bvW + 45} y2={b} {...dimStroke} />
                  <line x1={bvW + 38} y1={a} x2={bvW + 52} y2={a} {...dimStroke} />
                  <line x1={bvW + 38} y1={b} x2={bvW + 52} y2={b} {...dimStroke} />
                  <text x={bvW + 35} y={(a + b) / 2} textAnchor="middle" fontSize={fs} {...F}
                    transform={`rotate(-90 ${bvW + 35} ${(a + b) / 2})`}>{mm}</text>
                </g>
              );
            });
          })()}
          {legYs.map((y, i) => (
            <line key={"ey" + i} x1={bvW} y1={y * scale} x2={bvW + 52} y2={y * scale}
              stroke={faintInk} strokeWidth="1" strokeDasharray="4 4" />
          ))}

          <text x={bvW / 2} y={bvD + 100} textAnchor="middle" fontSize="19" fontWeight="600" {...F}>
            BOTTOM VIEW
          </text>
          <text x={bvW / 2} y={bvD + 128} textAnchor="middle" fontSize="13" fill={faintInk} fontFamily={mono}>
            * Leg positions dimensioned to leg centers
          </text>
        </g>

        {/* ── SPEC TABLE ── */}
        <g transform={`translate(${PADX + bvW + COLGAP},${bvY})`}>
          <text x="0" y="-16" fontSize="15" fontFamily={mono} fill={faintInk} letterSpacing="2">SPECIFICATIONS</text>
          {[
            ["BOARD SIZE", `${w.toLocaleString()} × ${d.toLocaleString()} mm`],
            ["BOARD THICKNESS", `${t} mm`],
            ["LEG HEIGHT", `${LEG_H} mm`],
            ["TOTAL HEIGHT", `${H} mm`],
            ["LEGS (QTY)", `${n} pcs`],
          ].map(([k, v], i) => (
            <g key={k} transform={`translate(0,${i * 58})`}>
              <rect x="0" y="0" width={tableW} height="58" fill={i % 2 ? "#F2F5F8" : "none"}
                stroke={ink} strokeWidth="1.5" />
              <text x="14" y="22" fontSize="13" fill={faintInk} fontFamily={mono} letterSpacing="1">{k}</text>
              <text x="14" y="47" fontSize="22" fontWeight="600" {...F}>{v}</text>
            </g>
          ))}
        </g>

        {/* ── FRONT / SIDE VIEWS ── */}
        <g transform={`translate(${PADX},${rowY})`}>
          <Elevation width={bvW} positions={legXs} title="FRONT VIEW" showHeightDims={false} />
        </g>
        <g transform={`translate(${PADX + bvW + COLGAP},${rowY})`}>
          <Elevation width={svW} positions={legYs} title="SIDE VIEW" showHeightDims={true} />
        </g>

        {/* ── PRICE TABLE ── */}
        <g transform={`translate(${PADX},${priceY})`}>
          <text x="0" y="-16" fontSize="15" fontFamily={mono} fill={faintInk} letterSpacing="2">PRICE</text>
          {priceRows.map(([k, v], i, arr) => {
            const last = i === arr.length - 1;
            const rowW = sheetW - PADX * 2;
            return (
              <g key={k} transform={`translate(0,${i * 58})`}>
                <rect x="0" y="0" width={rowW} height="58"
                  fill={last ? "#E7F3EE" : i % 2 ? "#F2F5F8" : "none"} stroke={ink} strokeWidth="1.5" />
                <text x="16" y="37" fontSize="16" fill={faintInk} fontFamily={mono} letterSpacing="1">{k}</text>
                {i === 0 ? (
                  <text x="300" y="38" fontSize="21" fontWeight="500" {...F}>{v}</text>
                ) : (
                  <text x={rowW - 20} y="38" textAnchor="end"
                    fontSize={last ? 26 : 21} fontWeight={last ? "700" : "500"} {...F}>{v}</text>
                )}
              </g>
            );
          })}
          <g fontFamily={mono} fontSize="15" fill={faintInk}>
            <text x="0" y={priceRows.length * 58 + 32}>
              * Prices exclude VAT 7%. {shipping ? "Shipping cost is included in the unit price." : "Shipping cost is not included."}
            </text>
            <text x="0" y={priceRows.length * 58 + 60}>
              * This quotation is valid for 1 month from the date of issue.
            </text>
          </g>
        </g>

        {/* ── Footer: company info + prepared by ── */}
        <g transform={`translate(${PADX},${footerY})`}>
          <line x1="0" y1="0" x2={sheetW - PADX * 2} y2="0" stroke={ink} strokeWidth="1.5" />

          {/* left: full company block */}
          <text x="0" y="38" fontSize="20" fontWeight="700" {...F}>FiX3RD Co., Ltd.</text>
          <g fontFamily={mono} fontSize="14" fill={ink}>
            <text x="0" y="68">Head Office: 333/14, Moo 2, Racha Thewa Subdistrict, Bang Phli District, Samut Prakan Province.</text>
            <text x="0" y="94">Branch Office: No. 168/29, Soi Chonburi-Ban Bueng 1, Chonburi-Ban Bueng Road, Ban Bueng Subdistrict, Ban Bueng District, Chonburi Province.</text>
            <text x="0" y="120">Tax ID: 0205568056071 · Tel: 081-444-5023 · Line ID: chiharu_ito</text>
            <text x="0" y="146">Email: mk@carry.in.th / chiharuito@hotmail.com · URL: www.fix3rd.com</text>
          </g>

          {/* right: prepared by */}
          <g transform={`translate(${sheetW - PADX * 2},0)`}>
            <text x="0" y="38" textAnchor="end" fontSize="16" fontFamily={mono} fill={faintInk}>Prepared by</text>
            <text x="0" y="68" textAnchor="end" fontSize="20" fontWeight="700" {...F}>{preparedBy || "—"}</text>
            <line x1="-320" y1="86" x2="0" y2="86" stroke={faintInk} strokeWidth="1.5" />
            <text x="0" y="110" textAnchor="end" fontSize="13" fontFamily={mono} fill={faintInk}>
              Authorized signature
            </text>
          </g>

          <text x="0" y="186" fontSize="12" fontFamily={mono} fill={faintInk}>
            Drawing scale: reference only
          </text>
        </g>
      </svg>

      <div className="mt-4 flex gap-2">
        <Btn primary onClick={downloadPDF}>Download PDF</Btn>
        <Btn onClick={downloadPNG}>Download PNG</Btn>
      </div>
    </div>
  );
}

/* ═══════════════════ MAIN APP ═══════════════════════════════ */
export default function PalletLegEditor() {
  const [step, setStep] = useState("edit");
  const [w, setW] = useState(1100);
  const [d, setD] = useState(1100);
  const [wIn, setWIn] = useState("1100");
  const [dIn, setDIn] = useState("1100");
  const [t, setT] = useState(12);
  const [boardPrice, setBoardPrice] = useState("130");
  const [legPrice, setLegPrice] = useState("21.5");
  const [profit, setProfit] = useState("30");
  const [moqIn, setMoqIn] = useState("100");
  const [shipping, setShipping] = useState(false);
  const [shipCost, setShipCost] = useState("0");
  const [company, setCompany] = useState("");
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [preparedBy, setPreparedBy] = useState("Chiharu Ito Jr.");
  const [legs, setLegs] = useState(PRESETS[5](1100, 1100).map(mkLeg));
  const [cursor, setCursor] = useState(null);
  const [flash, setFlash] = useState(null);
  const svgRef = useRef(null);

  const applySize = () => {
    const nw = clamp(Math.round(num(wIn)) || 1100, MIN_DIM, MAX_W);
    const nd = clamp(Math.round(num(dIn)) || 1100, MIN_DIM, MAX_D);
    setW(nw); setD(nd); setWIn(String(nw)); setDIn(String(nd));
    setLegs((ls) => ls.map((l) => ({
      ...l,
      x: clamp(l.x, MARGIN, nw - MARGIN),
      y: clamp(l.y, MARGIN, nd - MARGIN),
    })));
  };

  const PAD = 90;
  const toMM = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x - PAD, y: p.y - PAD };
  }, []);
  const snap = (v) => Math.round(v / SNAP) * SNAP;

  const dragRef = useRef(null);            // { id, sx, sy, moved } | { consumed }
  const [dragId, setDragId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draftX, setDraftX] = useState("");
  const [draftY, setDraftY] = useState("");
  const DRAG_THRESHOLD = 20;               // mm of movement before a press becomes a drag

  const selectedLeg = legs.find((l) => l.id === selectedId) || null;

  // keep the X/Y draft fields in sync with the selected leg
  useEffect(() => {
    const l = legs.find((x) => x.id === selectedId);
    if (l) { setDraftX(String(l.x)); setDraftY(String(l.y)); }
  }, [selectedId, legs]);

  const moveLeg = (id, nx, ny) => {
    const x = clamp(Math.round(nx), MARGIN, w - MARGIN);
    const y = clamp(Math.round(ny), MARGIN, d - MARGIN);
    setLegs((ls) => {
      if (ls.some((l) => l.id !== id && overlaps(l, x, y))) return ls;
      return ls.map((l) => (l.id === id ? { ...l, x, y } : l));
    });
  };

  const deleteSelected = () => {
    if (selectedId == null) return;
    setLegs((ls) => ls.filter((l) => l.id !== selectedId));
    setSelectedId(null);
  };

  const handlePointerDown = (e) => {
    const p = toMM(e);
    if (!p || p.x < 0 || p.y < 0 || p.x > w || p.y > d) return;
    const hit = legs.find((l) => onLeg(l, p.x, p.y));
    if (hit) {
      dragRef.current = { id: hit.id, sx: p.x, sy: p.y, moved: false };
      setDragId(hit.id);
      svgRef.current?.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  };

  const handlePointerMove = (e) => {
    const p = toMM(e);
    const drag = dragRef.current;
    if (drag && drag.id != null && p) {
      if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) > DRAG_THRESHOLD) {
        drag.moved = true;
        setSelectedId(drag.id);
      }
      if (drag.moved) {
        const x = clamp(snap(p.x), MARGIN, w - MARGIN);
        const y = clamp(snap(p.y), MARGIN, d - MARGIN);
        setLegs((ls) => {
          if (ls.some((l) => l.id !== drag.id && overlaps(l, x, y))) return ls;
          return ls.map((l) => (l.id === drag.id ? { ...l, x, y } : l));
        });
        setCursor({ x, y });
        return;
      }
    }
    if (!p || p.x < 0 || p.y < 0 || p.x > w || p.y > d) { setCursor(null); return; }
    setCursor({ x: snap(p.x), y: snap(p.y) });
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    if (drag && drag.id != null) {
      if (!drag.moved) {
        // tap on a leg → select / deselect it (edit position below)
        setSelectedId((prev) => (prev === drag.id ? null : drag.id));
      }
      dragRef.current = { consumed: true }; // suppress the follow-up click event
      setDragId(null);
      setTimeout(() => { if (dragRef.current?.consumed) dragRef.current = null; }, 0);
    }
  };

  const handleClick = (e) => {
    if (dragRef.current) { dragRef.current = null; return; } // click came from a leg tap/drag
    const p = toMM(e);
    if (!p || p.x < 0 || p.y < 0 || p.x > w || p.y > d) return;
    if (legs.some((l) => onLeg(l, p.x, p.y))) return;
    const x = clamp(snap(p.x), MARGIN, w - MARGIN);
    const y = clamp(snap(p.y), MARGIN, d - MARGIN);
    if (legs.some((l) => overlaps(l, x, y))) return;
    const leg = mkLeg([x, y]);
    setLegs((ls) => [...ls, leg]);
    setSelectedId(leg.id);
    setFlash(leg.id);
    setTimeout(() => setFlash(null), 400);
  };

  /* derived */
  const n = legs.length;
  const moq = Math.max(1, Math.round(num(moqIn)));
  const boardLimit = Math.round((w * d) / (1100 * 1100) * 2000 / 100) * 100 || 2000;
  const capacity = Math.min(n * LEG_KG, boardLimit);
  const cost = num(boardPrice) + num(legPrice) * n;                    // material cost
  const basePrice = cost * (1 + num(profit) / 100);                    // with margin
  const shipPerPc = shipping ? num(shipCost) / moq : 0;                // shipping ÷ MOQ
  const unitPrice = Math.round(basePrice + shipPerPc);                 // final unit price
  const unstable = n < 3;
  const capped = n * LEG_KG > boardLimit;
  const status = unstable
    ? { color: T.red, msg: "Fewer than 3 legs — cannot stand" }
    : n < 4
    ? { color: T.amber, msg: "4+ legs recommended (corner support)" }
    : capped
    ? { color: T.blue, msg: "Board load limit reached (legs have margin)" }
    : { color: T.accent, msg: "Configuration OK" };

  const gridLines = useMemo(() => {
    const minor = [], major = [];
    for (let x = 0; x <= w; x += 50) (x % 250 === 0 ? major : minor).push(["v", x]);
    for (let y = 0; y <= d; y += 50) (y % 250 === 0 ? major : minor).push(["h", y]);
    return { minor, major };
  }, [w, d]);

  const vbW = w + PAD * 2, vbH = d + PAD * 2;

  return (
    <div className="min-h-screen w-full" style={{ background: T.bg, color: T.text, fontFamily: sans }}>
      <div className="mx-auto max-w-5xl px-4 py-6">

        <header className="flex flex-wrap items-end justify-between gap-3 pb-4"
          style={{ borderBottom: `1px solid ${T.line}` }}>
          <div>
            <div className="text-xs tracking-widest uppercase" style={{ color: T.accent, fontFamily: mono }}>
              FiX3RD · Leg Layout Editor
            </div>
            <h1 className="text-xl font-semibold mt-1">Smart Pallet Load Simulator</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: step === "edit" ? T.accent : T.faint, fontFamily: mono }}>1 LAYOUT</span>
            <span style={{ color: T.faint }}>→</span>
            <span className="text-xs" style={{ color: step === "drawing" ? T.accent : T.faint, fontFamily: mono }}>2 QUOTATION</span>
          </div>
        </header>

        {step === "drawing" ? (
          <div className="mt-5">
            <div className="mb-4 flex gap-2">
              <Btn onClick={() => setStep("edit")}>← Back to editor</Btn>
            </div>
            <QuotationSheet w={w} d={d} t={t} legs={legs}
              unitPrice={unitPrice} moq={moq} shipping={shipping}
              customer={{ company, address, contact }}
              preparedBy={preparedBy} />
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* ── Canvas ── */}
            <div className="lg:col-span-2 rounded-2xl p-4"
              style={{ background: T.panel, border: `1px solid ${T.line}` }}>

              <div className="flex flex-wrap items-center gap-3 mb-3 pb-3"
                style={{ borderBottom: `1px solid ${T.line}` }}>
                <NumField label="W" value={wIn} onChange={setWIn} unit="mm" w="5rem" />
                <NumField label="D" value={dIn} onChange={setDIn} unit="mm" w="5rem" />
                <Btn onClick={applySize}>Apply size</Btn>
                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-xs" style={{ color: T.dim }}>Thickness</span>
                  {[12, 15].map((v) => (
                    <Btn key={v} active={t === v} onClick={() => setT(v)}>{v} mm</Btn>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs" style={{ color: T.dim }}>Presets</span>
                  {[4, 5, 6, 7, 8, 9].map((k) => (
                    <Btn key={k} onClick={() => { setLegs(PRESETS[k](w, d).map(mkLeg)); setSelectedId(null); }}>
                      {k}
                    </Btn>
                  ))}
                  <Btn danger onClick={() => { setLegs([]); setSelectedId(null); }}>Clear</Btn>
                </div>
                <div className="text-xs" style={{ color: T.faint, fontFamily: mono }}>
                  {cursor ? `X ${cursor.x} · Y ${cursor.y} mm` : "SNAP 25 mm"}
                </div>
              </div>

              <svg ref={svgRef} viewBox={`0 0 ${vbW} ${vbH}`} className="w-full select-none"
                style={{ cursor: dragId ? "grabbing" : "crosshair", touchAction: "none", display: "block" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onMouseLeave={() => setCursor(null)}
                onClick={handleClick}>
                <g transform={`translate(${PAD},${PAD})`}>
                  <rect x="0" y="0" width={w} height={d} rx="14"
                    fill={T.board} stroke={T.boardEdge} strokeWidth="4" />
                  {gridLines.minor.map(([o, v], i) => o === "v"
                    ? <line key={"m" + i} x1={v} y1="0" x2={v} y2={d} stroke={T.grid} strokeWidth="1" />
                    : <line key={"m" + i} x1="0" y1={v} x2={w} y2={v} stroke={T.grid} strokeWidth="1" />)}
                  {gridLines.major.map(([o, v], i) => o === "v"
                    ? <line key={"M" + i} x1={v} y1="0" x2={v} y2={d} stroke={T.gridMajor} strokeWidth="1.5" />
                    : <line key={"M" + i} x1="0" y1={v} x2={w} y2={v} stroke={T.gridMajor} strokeWidth="1.5" />)}

                  <g stroke={T.faint} strokeWidth="2" fill={T.faint} fontFamily={mono} fontSize="34">
                    <line x1="0" y1={-45} x2={w} y2={-45} />
                    <line x1="0" y1={-58} x2="0" y2={-32} />
                    <line x1={w} y1={-58} x2={w} y2={-32} />
                    <text x={w / 2} y={-62} textAnchor="middle" stroke="none">{w.toLocaleString()} mm</text>
                    <line x1={-45} y1="0" x2={-45} y2={d} />
                    <line x1={-58} y1="0" x2={-32} y2="0" />
                    <line x1={-58} y1={d} x2={-32} y2={d} />
                    <text x={-62} y={d / 2} textAnchor="middle" stroke="none"
                      transform={`rotate(-90 ${-62} ${d / 2})`}>{d.toLocaleString()} mm</text>
                  </g>

                  {cursor && !dragId && !legs.some((l) => onLeg(l, cursor.x, cursor.y)) && (
                    <circle cx={cursor.x} cy={cursor.y} r={LEG_SIZE / 2}
                      fill="none" stroke={T.accent} strokeWidth="3" strokeDasharray="10 8" opacity="0.55" />
                  )}

                  {legs.map((l) => {
                    const active = dragId === l.id || selectedId === l.id;
                    return (
                      <g key={l.id} style={{ cursor: "grab" }}>
                        {active && (
                          <circle cx={l.x} cy={l.y} r={LEG_SIZE / 2 + 16}
                            fill="none" stroke={T.accent} strokeWidth="2" strokeDasharray="8 8" opacity="0.6" />
                        )}
                        <circle cx={l.x} cy={l.y} r={LEG_SIZE / 2}
                          fill={active || flash === l.id ? T.accent : "#243D34"}
                          stroke={T.accent} strokeWidth="4"
                          style={{ transition: "fill .2s" }} />
                        <circle cx={l.x} cy={l.y} r="34" fill="none"
                          stroke={active ? "#0C1712" : T.accent} strokeWidth="3" opacity="0.7" />
                        <circle cx={l.x} cy={l.y} r="8" fill={active ? "#0C1712" : T.accent} />
                      </g>
                    );
                  })}
                </g>
              </svg>

              <p className="mt-3 text-xs leading-relaxed" style={{ color: T.dim }}>
                Tap an empty area to add a leg · tap a leg to select it (edit exact position below) · drag to move.
                Board must fit a standard sheet: W {MIN_DIM}–{MAX_W.toLocaleString()} / D {MIN_DIM}–{MAX_D.toLocaleString()} mm.
              </p>

              {/* selected leg — exact position editor */}
              {selectedLeg && (
                <div className="mt-3 rounded-xl p-4 flex flex-col gap-3"
                  style={{ background: T.panel2, border: `1px solid ${T.accent}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs tracking-widest uppercase" style={{ color: T.accent }}>
                      Selected leg — exact position (mm)
                    </span>
                    <div className="flex gap-2">
                      <Btn danger onClick={deleteSelected}>Delete leg</Btn>
                      <Btn onClick={() => setSelectedId(null)}>Done</Btn>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    {/* directional pad (25 mm / tap) */}
                    <div className="grid grid-cols-3 gap-1" style={{ width: "8.5rem" }}>
                      <span />
                      <Btn onClick={() => moveLeg(selectedLeg.id, selectedLeg.x, selectedLeg.y - 25)}>↑</Btn>
                      <span />
                      <Btn onClick={() => moveLeg(selectedLeg.id, selectedLeg.x - 25, selectedLeg.y)}>←</Btn>
                      <div className="flex items-center justify-center text-xs rounded-lg"
                        style={{ color: T.faint, border: `1px dashed ${T.line}`, fontFamily: mono }}>25</div>
                      <Btn onClick={() => moveLeg(selectedLeg.id, selectedLeg.x + 25, selectedLeg.y)}>→</Btn>
                      <span />
                      <Btn onClick={() => moveLeg(selectedLeg.id, selectedLeg.x, selectedLeg.y + 25)}>↓</Btn>
                      <span />
                    </div>

                    {/* exact numeric position */}
                    <div className="flex flex-col gap-2 flex-1" style={{ minWidth: "14rem" }}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs w-24" style={{ color: T.dim }}>X (from left)</span>
                        <input type="number" inputMode="numeric" value={draftX}
                          onChange={(e) => setDraftX(e.target.value)}
                          onBlur={() => moveLeg(selectedLeg.id, num(draftX), selectedLeg.y)}
                          onKeyDown={(e) => e.key === "Enter" && moveLeg(selectedLeg.id, num(draftX), selectedLeg.y)}
                          className="rounded-lg px-2 py-1.5 text-right tabular-nums outline-none flex-1"
                          style={{ minWidth: "4rem", background: T.bg, color: T.text, border: `1px solid ${T.line}`, fontFamily: mono }} />
                        <span className="text-xs" style={{ color: T.dim }}>mm</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs w-24" style={{ color: T.dim }}>Y (from top)</span>
                        <input type="number" inputMode="numeric" value={draftY}
                          onChange={(e) => setDraftY(e.target.value)}
                          onBlur={() => moveLeg(selectedLeg.id, selectedLeg.x, num(draftY))}
                          onKeyDown={(e) => e.key === "Enter" && moveLeg(selectedLeg.id, selectedLeg.x, num(draftY))}
                          className="rounded-lg px-2 py-1.5 text-right tabular-nums outline-none flex-1"
                          style={{ minWidth: "4rem", background: T.bg, color: T.text, border: `1px solid ${T.line}`, fontFamily: mono }} />
                        <span className="text-xs" style={{ color: T.dim }}>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs pt-2"
                    style={{ borderTop: `1px solid ${T.line}`, color: T.faint, fontFamily: mono }}>
                    <span>← left <span style={{ color: T.text }}>{selectedLeg.x}</span></span>
                    <span>right → <span style={{ color: T.text }}>{w - selectedLeg.x}</span></span>
                    <span>↑ top <span style={{ color: T.text }}>{selectedLeg.y}</span></span>
                    <span>bottom ↓ <span style={{ color: T.text }}>{d - selectedLeg.y}</span></span>
                    <span style={{ color: T.faint }}>(to leg center · min {MARGIN} from each edge)</span>
                  </div>
                </div>
              )}

              {/* customer / quotation info */}
              <div className="mt-4 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
                style={{ borderTop: `1px solid ${T.line}` }}>
                <div className="sm:col-span-2 text-xs tracking-widest uppercase" style={{ color: T.dim }}>
                  Quotation details
                </div>
                <TextField label="Customer company" value={company} onChange={setCompany} placeholder="e.g. Tri-Wall (Thailand) Co., Ltd." />
                <TextField label="Contact person (Attn)" value={contact} onChange={setContact} placeholder="e.g. Khun Panwipa" />
                <div className="sm:col-span-2">
                  <TextField label="Customer address" value={address} onChange={setAddress} placeholder="e.g. 123 Bangna-Trad Rd., Bangkok 10260" />
                </div>
                <TextField label="Prepared by" value={preparedBy} onChange={setPreparedBy} />
              </div>
            </div>

            {/* ── Dashboard ── */}
            <div className="flex flex-col gap-4">

              <div className="rounded-xl p-5"
                style={{ background: T.panel2, border: `1px solid ${T.line}` }}>
                <div className="text-xs tracking-widest uppercase" style={{ color: T.dim }}>
                  Total legs placed
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-5xl font-bold tabular-nums" style={{ color: T.accent, fontFamily: mono }}>{n}</span>
                  <span className="text-base" style={{ color: T.dim }}>pcs</span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: status.color }}>
                  <span className="inline-block h-2 w-2 rounded-full"
                    style={{ background: status.color, boxShadow: `0 0 8px ${status.color}` }} />
                  {status.msg}
                </div>
              </div>

              <Gauge label="Est. load capacity (static)" value={capacity} max={boardLimit}
                unit="kg" color={unstable ? T.red : capped ? T.blue : T.accent}
                note={`${LEG_KG}kg/leg · limit ${boardLimit.toLocaleString()}kg`} />

              {/* price calculator */}
              <div className="rounded-xl p-4 flex flex-col gap-2.5"
                style={{ background: T.panel2, border: `1px solid ${T.line}` }}>
                <div className="text-xs tracking-widest uppercase" style={{ color: T.dim }}>
                  Price calculator
                </div>
                <NumField label="Board price" value={boardPrice} onChange={setBoardPrice} unit="THB" />
                <NumField label="Leg unit price" value={legPrice} onChange={setLegPrice} unit="THB" />
                <NumField label="Profit margin" value={profit} onChange={setProfit} unit="%" />
                <NumField label="MOQ" value={moqIn} onChange={setMoqIn} unit="pcs" />

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs" style={{ color: T.dim }}>Shipping</span>
                  <div className="flex gap-1.5">
                    <Btn active={!shipping} onClick={() => setShipping(false)}>Excluded</Btn>
                    <Btn active={shipping} onClick={() => setShipping(true)}>Included</Btn>
                  </div>
                </div>
                {shipping && (
                  <NumField label="Shipping cost (total)" value={shipCost} onChange={setShipCost} unit="THB" />
                )}

                <div className="pt-2 text-xs flex flex-col gap-1"
                  style={{ borderTop: `1px solid ${T.line}`, color: T.faint, fontFamily: mono }}>
                  <div className="flex justify-between">
                    <span>Material cost (board + legs×{n})</span>
                    <span>{cost.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>+ Margin {num(profit)}%</span>
                    <span>{basePrice.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                  </div>
                  {shipping && (
                    <div className="flex justify-between">
                      <span>+ Shipping ÷ MOQ ({moq.toLocaleString()})</span>
                      <span>{shipPerPc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs" style={{ color: T.dim }}>Unit selling price</span>
                  <span className="text-2xl font-bold tabular-nums" style={{ color: T.amber, fontFamily: mono }}>
                    {unitPrice.toLocaleString()} <span className="text-sm font-normal" style={{ color: T.dim }}>THB/pc</span>
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs" style={{ color: T.dim }}>Total (× MOQ)</span>
                  <span className="text-base font-semibold tabular-nums" style={{ color: T.text, fontFamily: mono }}>
                    {(unitPrice * moq).toLocaleString()} <span className="text-xs font-normal" style={{ color: T.dim }}>THB</span>
                  </span>
                </div>
              </div>

              {/* spec summary */}
              <div className="rounded-xl p-4 text-xs flex flex-col gap-1.5"
                style={{ background: T.panel2, border: `1px solid ${T.line}`, color: T.dim, fontFamily: mono }}>
                <div className="flex justify-between"><span>BOARD</span><span style={{ color: T.text }}>{w.toLocaleString()} × {d.toLocaleString()} × t{t}</span></div>
                <div className="flex justify-between"><span>LEG HEIGHT</span><span style={{ color: T.text }}>{LEG_H} mm</span></div>
                <div className="flex justify-between"><span>TOTAL HEIGHT</span><span style={{ color: T.text }}>{LEG_H + t} mm</span></div>
              </div>

              <button onClick={() => setStep("drawing")}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-transform active:scale-95"
                style={{ background: T.accent, color: "#0C1712", border: `1px solid ${T.accent}` }}>
                Next — Generate quotation →
              </button>

              <p className="text-xs leading-relaxed" style={{ color: T.faint }}>
                * The quotation shows the selling price only (cost, margin and shipping breakdown stay hidden).
                Load capacity is a simplified model.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
