'use strict';
// Tiny dependency-free PDF writer, just enough for a one-page tax invoice. Uses the three
// built-in PDF standard fonts (Helvetica, Helvetica-Bold, Courier) so nothing is embedded.
// A4 in points (72/inch): 595.28 x 841.89. Origin is bottom-left.
const PAGE_W = 595.28, PAGE_H = 841.89, M = 50;

// PDF text is Latin-1-ish with these standard fonts; transliterate common typographic
// characters to ASCII and drop anything else so the output never mis-renders.
function ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[‐-―−]/g, '-').replace(/[·•]/g, '-')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/ /g, ' ')
    .replace(/[^\x20-\x7e]/g, '');
}
const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const fmtMoney = (n) => 'A$' + (Math.round((+n || 0) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }); };

// Builder: accumulate content-stream operators; y arguments are measured from the page top.
function builder() {
  const ops = [];
  const yy = (top) => (PAGE_H - top).toFixed(2);
  const F = { reg: 'F1', bold: 'F2', mono: 'F3' };
  return {
    ops,
    text(x, top, str, { font = F.reg, size = 10, color } = {}) {
      if (color) ops.push(`${color} rg`);
      ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${yy(top)} Td (${esc(str)}) Tj ET`);
      if (color) ops.push('0 0 0 rg');
    },
    // Right-align using Courier's fixed 0.6em advance (only used for numeric columns).
    rightMono(xRight, top, str, size = 10) {
      const w = ascii(str).length * size * 0.6;
      this.text(xRight - w, top, str, { font: F.mono, size });
    },
    line(x1, top1, x2, top2, w = 0.7, gray) {
      ops.push(`${w} w`); if (gray != null) ops.push(`${gray} G`);
      ops.push(`${x1.toFixed(2)} ${yy(top1)} m ${x2.toFixed(2)} ${yy(top2)} l S`);
      if (gray != null) ops.push('0 G');
    },
    rect(x, top, w, h, gray) { ops.push(`${gray} rg ${x.toFixed(2)} ${yy(top + h)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`); },
    build() { return ops.join('\n'); },
  };
}

// Render an invoice to a PDF Buffer. inv: the invoice record; calc: { lines, sub, gst, total, rate };
// s: settings.invoice (entity, abn, address, email, phone, bank, footer).
function invoicePdf(inv, calc, s = {}) {
  const b = builder();
  const rightX = PAGE_W - M;
  let y = M + 6;
  // Header: brand + TAX INVOICE
  b.text(M, y, 'GBX', { font: 'F2', size: 20 });
  b.text(M + 46, y - 2, 'PROFESSIONAL SERVICES', { font: 'F1', size: 8, color: '0.42 0.42 0.4' });
  b.text(rightX - 120, y, 'TAX INVOICE', { font: 'F2', size: 16 });
  if ((inv.status || 'Draft') === 'Draft') b.text(rightX - 120, y + 16, 'DRAFT - not yet issued', { font: 'F1', size: 8, color: '0.7 0.28 0.24' });
  y += 20;
  b.text(M, y, ascii(s.entity || 'GBX Professional Services'), { font: 'F1', size: 9, color: '0.35 0.35 0.33' });
  y += 12;
  (s.abn ? ['ABN ' + s.abn] : []).concat(String(s.address || '').split('\n')).filter(Boolean).forEach((ln) => { b.text(M, y, ln, { font: 'F1', size: 8.5, color: '0.42 0.42 0.4' }); y += 11; });
  if (s.email || s.phone) { b.text(M, y, [s.email, s.phone].filter(Boolean).join('  -  '), { font: 'F1', size: 8.5, color: '0.42 0.42 0.4' }); y += 11; }

  // Meta block (right)
  let my = M + 30;
  const meta = [['Invoice', inv.number], ['Issued', fmtDate(inv.issued)], ['Due', fmtDate(inv.due)]];
  if (inv.ref) meta.push(['Reference', inv.ref]);
  meta.forEach(([k, v]) => { b.text(rightX - 200, my, k, { font: 'F1', size: 9, color: '0.42 0.42 0.4' }); b.text(rightX - 120, my, String(v), { font: 'F2', size: 9 }); my += 13; });

  // Bill to
  y = Math.max(y, my) + 16;
  b.text(M, y, 'BILL TO', { font: 'F2', size: 8, color: '0.42 0.42 0.4' }); y += 14;
  const c = inv.client || {};
  [c.name, c.contact, ...String(c.address || '').split('\n'), c.abn ? 'ABN ' + c.abn : '', c.email].filter(Boolean).forEach((ln, i) => { b.text(M, y, ln, { font: i === 0 ? 'F2' : 'F1', size: i === 0 ? 11 : 9, color: i === 0 ? null : '0.3 0.3 0.28' }); y += i === 0 ? 15 : 12; });

  // Line items table
  y += 14;
  const colQty = rightX - 210, colUnit = rightX - 120, colAmt = rightX;
  b.rect(M, y - 10, rightX - M, 20, '0.95 0.94 0.91');
  b.text(M + 6, y + 4, 'DESCRIPTION', { font: 'F2', size: 8, color: '0.35 0.35 0.33' });
  b.text(colQty - 24, y + 4, 'QTY', { font: 'F2', size: 8, color: '0.35 0.35 0.33' });
  b.text(colUnit - 30, y + 4, 'UNIT', { font: 'F2', size: 8, color: '0.35 0.35 0.33' });
  b.text(colAmt - 44, y + 4, 'AMOUNT', { font: 'F2', size: 8, color: '0.35 0.35 0.33' });
  y += 24;
  (calc.lines || []).forEach((l) => {
    const desc = ascii(l.desc || '');
    b.text(M + 6, y, desc.length > 58 ? desc.slice(0, 57) + '...' : desc, { font: 'F1', size: 9.5 });
    b.rightMono(colQty, y, String(l.qty ?? ''), 9.5);
    b.rightMono(colUnit, y, fmtMoney(l.unit), 9.5);
    b.rightMono(colAmt, y, fmtMoney(l.total), 9.5);
    y += 16; b.line(M, y - 6, rightX, y - 6, 0.4, 0.85);
  });

  // Totals
  y += 8;
  const gstLabel = `GST (${Math.round((calc.rate || 0.1) * 100)}%)`;
  const totals = [['Subtotal (ex GST)', fmtMoney(calc.sub)], [gstLabel, fmtMoney(calc.gst)]];
  totals.forEach(([k, v]) => { b.text(colUnit - 30, y, k, { font: 'F1', size: 9.5, color: '0.35 0.35 0.33' }); b.rightMono(colAmt, y, v, 9.5); y += 15; });
  b.line(colUnit - 34, y - 2, rightX, y - 2, 0.7, 0.6);
  y += 8;
  b.text(colUnit - 30, y, 'Total inc GST', { font: 'F2', size: 11 }); b.rightMono(colAmt, y, fmtMoney(calc.total), 11);
  y += 30;

  // Payment details + footer
  if (s.bank) { b.text(M, y, 'PAYMENT', { font: 'F2', size: 8, color: '0.42 0.42 0.4' }); y += 13; b.text(M, y, ascii(s.bank), { font: 'F1', size: 9.5 }); y += 16; }
  if (inv.notes) { String(inv.notes).split('\n').forEach((ln) => { b.text(M, y, ln, { font: 'F1', size: 9, color: '0.3 0.3 0.28' }); y += 12; }); y += 4; }
  if (s.footer) b.text(M, y, ascii(s.footer), { font: 'F1', size: 8.5, color: '0.5 0.5 0.48' });

  return assemble(b.build());
}

// Assemble a minimal PDF file with a content stream and the three standard fonts.
function assemble(content) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

module.exports = { invoicePdf };
