'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* 限空令／禁空令研究：靜態頁放在 public/research/short-ban.html，用同源 iframe 嵌入，
   載入後依內容高度自動撐開，讓整頁只有一條捲軸。 */
const SRC = '/research/short-ban.html';

export default function ShortBanStudyTab() {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1600);

  const fit = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setHeight(doc.documentElement.scrollHeight);
  }, []);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    const onLoad = () => {
      fit();
      const body = iframe.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(fit);
        ro.observe(body);
      }
    };
    iframe.addEventListener('load', onLoad);
    if (iframe.contentDocument?.readyState === 'complete') onLoad();
    return () => { iframe.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [fit]);

  return (
    <div>
      <div style={{ textAlign: 'right', fontSize: 13, marginBottom: 8 }}>
        <a href={SRC} target="_blank" rel="noopener noreferrer" style={{ color: '#1c5cab' }}>
          ↗ 在新分頁開啟完整頁面
        </a>
      </div>
      <iframe
        ref={ref}
        src={SRC}
        title="台股限空令／禁空令後的市場表現回顧"
        style={{ width: '100%', height, border: 0, display: 'block', borderRadius: 12 }}
      />
    </div>
  );
}
