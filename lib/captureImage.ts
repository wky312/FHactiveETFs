/**
 * 把一個 DOM 區塊截成圖片並（手機優先）分享 / 下載。
 *
 * 重點：截圖前先把所有「會裁切內容」的容器暫時攤平成內容全尺寸，截完再還原：
 *   - 橫向（overflow-x + 內容比可視寬）→ 解決寬表格右側欄位被切掉
 *   - 縱向（overflow-y: auto/scroll + maxHeight，如各頁表格清單）→ 解決長清單只截到可視範圍
 * 另外 sticky 表頭在攤平後會卡在畫面中間，截圖期間改回 static；
 * 圖太大時自動降倍率，避免手機（尤其 iOS Safari）超過 canvas 上限變成空白圖。
 */

/* iOS Safari 的 canvas 上限最嚴：邊長與總畫素都有天花板，超過就回空白。取保守值。 */
const MAX_DIM = 8192;
const MAX_AREA = 16.7e6;

/** 在 canvas 上限內能用的最大倍率（寧可解析度低一點，也要截到完整內容）。 */
function fitScale(w: number, h: number, preferred = 2): number {
  const s = Math.min(preferred, MAX_DIM / w, MAX_DIM / h, Math.sqrt(MAX_AREA / (w * h)));
  return Math.max(0.5, Math.floor(s * 100) / 100);
}

export async function captureAndShare(el: HTMLElement, filename: string, shareTitle: string): Promise<void> {
  const jpgName = filename.replace(/\.png$/i, '.jpg');

  // 1) 暫時攤平所有會裁切內容的容器
  const touched: { node: HTMLElement; css: string }[] = [];
  const nodes: HTMLElement[] = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    const cs = getComputedStyle(node);
    // 橫向連 hidden 也攤平（寬表格常見）；縱向只處理真正的滾動容器，
    // 避免把刻意用 overflow-y: hidden 收起來的區塊也展開。
    const wideX = /^(auto|scroll|hidden)$/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1;
    const tallY = /^(auto|scroll)$/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const sticky = cs.position === 'sticky';
    if (!wideX && !tallY && !sticky) continue;

    touched.push({ node, css: node.style.cssText });
    if (wideX) {
      node.style.overflowX = 'visible';
      node.style.width = `${node.scrollWidth}px`;
      node.style.maxWidth = 'none';
    }
    if (tallY) {
      node.style.overflowY = 'visible';
      node.style.height = `${node.scrollHeight}px`;
      node.style.maxHeight = 'none';
    }
    if (sticky) node.style.position = 'static';
  }
  // 等版面以新尺寸重新計算一幀
  await new Promise(r => requestAnimationFrame(() => r(null)));

  try {
    await document.fonts.ready;
    const html2canvas = (await import('html2canvas')).default;
    const w = Math.ceil(el.scrollWidth);
    const h = Math.ceil(el.scrollHeight);
    const canvas = await html2canvas(el, {
      scale: fitScale(w, h), backgroundColor: '#ffffff', useCORS: true, logging: false,
      width: w, height: h, windowWidth: w, windowHeight: h,
    });

    // 2) 手機優先 Web Share（可直接傳 LINE），否則下載 JPG
    if (typeof navigator !== 'undefined' && navigator.canShare) {
      try {
        const blob = await new Promise<Blob>(res => canvas.toBlob(b => res(b!), 'image/jpeg', 0.92));
        const file = new File([blob], jpgName, { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: shareTitle, files: [file] });
          return;
        }
      } catch { /* 取消或不支援 → 改下載 */ }
    }
    const link = document.createElement('a');
    link.download = jpgName;
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.click();
  } catch (e) {
    console.error('截圖失敗', e);
  } finally {
    // 3) 還原原本的 inline style
    touched.forEach(t => { t.node.style.cssText = t.css; });
  }
}
