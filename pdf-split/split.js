// A3・A4横3枚分などの横長PDFページを、A4ページに分割するロジック。
// ブラウザでは window.PdfSplit、Node では module.exports として使える。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pdf-lib'));
  } else {
    root.PdfSplit = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  const { PDFDocument, degrees } = PDFLib;
  const MM = 72 / 25.4;
  const A4_SHORT = 210 * MM;
  const A4_LONG = 297 * MM;

  function normRotation(page) {
    return (((page.getRotation().angle % 360) + 360) % 360);
  }

  // 見た目上（回転を反映した）の幅と高さ
  function visualSize(page) {
    const box = page.getCropBox();
    const r = normRotation(page);
    return r === 90 || r === 270
      ? { width: box.height, height: box.width }
      : { width: box.width, height: box.height };
  }

  // 分割数を判定する。まず縦横比で「A3型（√2）」か「A4×3枚型」かを見分け、
  // 縦横比が同じA3とA4だけは実寸で見分ける。スキャンなどで実寸がずれていても、
  // 縦横比が崩れていなければ正しく判定できる。
  //   A3横（420×297）      比 1.41 → 2分割（A4縦×2）
  //   A4縦×3（630×297）    比 2.12 → 3分割（A4縦×3）
  //   A4横×3（891×210）    比 4.24 → 3分割（A4横×3）
  //   A4（297×210）        比 1.41 → 1（そのまま）
  function classify(page) {
    const { width, height } = visualSize(page);
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    // 分割後の1枚の縦横比がA4（√2）からどれだけ離れているか
    const err = n => {
      const a = long / n;
      return Math.abs(Math.abs(Math.log(a / short)) - Math.log(Math.SQRT2));
    };
    const e1 = err(1);  // 1枚・2枚分割は縦横比が同じなので誤差も同じ
    const e3 = err(3);
    let n, kind;
    if (e3 < e1) {
      n = 3;
      kind = long / short > 3.2 ? 'A4横×3枚分' : 'A4縦×3枚分';
    } else if (long >= 360 * MM) {
      n = 2;
      kind = 'A3';
    } else {
      n = 1;
      kind = 'A4';
    }
    // 縦横比がどの型からも離れている（約8%以上）ときは要確認とする
    const unsure = Math.min(e1, e3) > 0.08;
    return { n, kind, unsure };
  }

  function detectSplit(page) {
    return classify(page).n;
  }

  // 見た目上の位置 i 番目の区画を、ページの（回転前の）座標系での矩形に変換する。
  // vertical=false: 左右に分割（左から i 番目）、true: 上下に分割（上から i 番目）
  function sliceRect(page, n, i, vertical) {
    const b = page.getCropBox();
    const r = normRotation(page);
    // 見た目の「左→右」または「上→下」が、元の座標系でどの軸のどの向きかを求める
    //   r=0:   左→右 = x増加,  上→下 = y減少
    //   r=90:  左→右 = y増加,  上→下 = x増加
    //   r=180: 左→右 = x減少,  上→下 = y増加
    //   r=270: 左→右 = y減少,  上→下 = x減少
    let axis, increasing;
    if (!vertical) {
      axis = r === 0 || r === 180 ? 'x' : 'y';
      increasing = r === 0 || r === 90;
    } else {
      axis = r === 0 || r === 180 ? 'y' : 'x';
      increasing = r === 90 || r === 180;
    }
    const len = axis === 'x' ? b.width : b.height;
    const step = len / n;
    const start = increasing ? i * step : len - (i + 1) * step;
    return axis === 'x'
      ? { x: b.x + start, y: b.y, width: step, height: b.height }
      : { x: b.x, y: b.y + start, width: b.width, height: step };
  }

  function sliceOrder(n, rightToLeft, vertical) {
    const idx = [...Array(n).keys()];
    return rightToLeft && !vertical ? idx.reverse() : idx;
  }

  /**
   * @param {ArrayBuffer|Uint8Array} bytes 入力PDF
   * @param {object} opts
   *   splits: ページごとの分割数の配列（省略時は自動判定）
   *   rightToLeft: 右側から順に並べる（縦書き資料など）
   *   fitA4: true ならA4用紙サイズに拡大縮小して配置、false なら切り取りのみ
   * @returns {Promise<Uint8Array>}
   */
  async function splitPdf(bytes, opts = {}) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const pages = src.getPages();
    const fitA4 = opts.fitA4 !== false;

    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const n = (opts.splits && opts.splits[p]) || detectSplit(page);
      const vs = visualSize(page);
      const vertical = vs.height > vs.width;
      const order = sliceOrder(n, !!opts.rightToLeft, vertical);

      if (!fitA4) {
        const copies = await out.copyPages(src, Array(n).fill(p));
        order.forEach((i, k) => {
          const rect = sliceRect(page, n, i, vertical);
          const pg = copies[k];
          pg.setMediaBox(rect.x, rect.y, rect.width, rect.height);
          pg.setCropBox(rect.x, rect.y, rect.width, rect.height);
          pg.setBleedBox(rect.x, rect.y, rect.width, rect.height);
          pg.setTrimBox(rect.x, rect.y, rect.width, rect.height);
          pg.setArtBox(rect.x, rect.y, rect.width, rect.height);
          out.addPage(pg);
        });
        continue;
      }

      const r = normRotation(page);
      // 中身のない白紙ページは埋め込めないので、白紙のA4をそのまま作る
      const blank = !page.node.Contents();
      for (const i of order) {
        const rect = sliceRect(page, n, i, vertical);
        if (blank) {
          const sideways = r === 90 || r === 270;
          const landscape = (sideways ? rect.height : rect.width) > (sideways ? rect.width : rect.height);
          out.addPage(landscape ? [A4_LONG, A4_SHORT] : [A4_SHORT, A4_LONG]);
          continue;
        }
        const emb = await out.embedPage(page, {
          left: rect.x,
          bottom: rect.y,
          right: rect.x + rect.width,
          top: rect.y + rect.height,
        });
        const sideways = r === 90 || r === 270;
        const vw = sideways ? rect.height : rect.width;
        const vh = sideways ? rect.width : rect.height;
        const [pw, ph] = vw > vh ? [A4_LONG, A4_SHORT] : [A4_SHORT, A4_LONG];
        const s = Math.min(pw / vw, ph / vh);
        const w = vw * s;
        const h = vh * s;
        const ox = (pw - w) / 2;
        const oy = (ph - h) / 2;
        // ページの /Rotate（時計回り）を描画時の回転で再現する
        const pos = {
          0: [ox, oy],
          90: [ox, oy + h],
          180: [ox + w, oy + h],
          270: [ox + w, oy],
        }[r];
        const newPage = out.addPage([pw, ph]);
        newPage.drawPage(emb, {
          x: pos[0],
          y: pos[1],
          xScale: s,
          yScale: s,
          rotate: degrees(-r),
        });
      }
    }
    return out.save();
  }

  function describePage(page) {
    const { width, height } = visualSize(page);
    const c = classify(page);
    return {
      widthMm: Math.round(width / MM),
      heightMm: Math.round(height / MM),
      auto: c.n,
      kind: c.kind,
      unsure: c.unsure,
    };
  }

  async function inspect(bytes) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return src.getPages().map(describePage);
  }

  return { splitPdf, inspect, detectSplit };
});
