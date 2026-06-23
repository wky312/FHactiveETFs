/**
 * 把一個 DOM 區塊截成圖片並（手機優先）分享 / 下載。
 *
 * 重點：截圖前先把所有「橫向裁切」的容器（overflow-x: auto/scroll/hidden 且內容比可視寬）
 * 暫時攤平成內容全寬，截完再還原 —— 解決寬表格存圖只截到可視範圍、超出欄位被切掉的問題。
 */
export async function captureAndShare(el: HTMLElement, filename: string, shareTitle: string): Promise<void> {
  const jpgName = filename.replace(/\.png$/i, '.jpg');

  // 1) 暫時攤平所有會裁切內容的容器
  const touched: { node: HTMLElement; css: string }[] = [];
  const nodes: HTMLElement[] = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    const ox = getComputedStyle(node).overflowX;
    if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && node.scrollWidth > node.clientWidth + 1) {
      touched.push({ node, css: node.style.cssText });
      node.style.overflowX = 'visible';
      node.style.width = `${node.scrollWidth}px`;
      node.style.maxWidth = 'none';
    }
  }
  // 等版面以新寬度重新計算一幀
  await new Promise(r => requestAnimationFrame(() => r(null)));

  try {
    await document.fonts.ready;
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(el, {
      scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false,
      width: el.scrollWidth, windowWidth: el.scrollWidth,
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
