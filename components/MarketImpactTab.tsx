'use client';
import { useState, useEffect } from 'react';
import TwMarketImpactTab from './TwMarketImpactTab';
import UsMarketImpactTab from './UsMarketImpactTab';

const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Market = 'tw' | 'us';

function segBtn(active: boolean): React.CSSProperties {
  return {
    padding: '8px 22px', background: active ? UP : CARD, color: active ? '#fff' : SUB,
    border: `1px solid ${active ? UP : BORDER}`, borderRadius: 999, cursor: 'pointer',
    fontSize: '.86rem', fontWeight: 700, fontFamily: SANS,
  };
}

/* 合併「美股收盤影響」＋「台股收盤影響」成一頁，內部用台股／美股切換，
   避免頂部導覽塞太多分頁。舊分享連結 ?tab=twimpact / usimpact 仍可正確還原市場別
   （在 Dashboard 把 tab 改寫成 'impact' 之前，這裡的初次渲染還讀得到舊值）。 */
export default function MarketImpactTab() {
  const sp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const legacyTab = sp0?.get('tab');
  const initMarket: Market =
    sp0?.get('market') === 'us' ? 'us' :
    sp0?.get('market') === 'tw' ? 'tw' :
    legacyTab === 'usimpact' ? 'us' : 'tw';
  const [market, setMarket] = useState<Market>(initMarket);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.set('tab', 'impact'); sp.set('market', market);
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  }, [market]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <button onClick={() => setMarket('tw')} style={segBtn(market === 'tw')}>台股收盤影響</button>
        <button onClick={() => setMarket('us')} style={segBtn(market === 'us')}>美股收盤影響</button>
      </div>
      {market === 'tw' ? <TwMarketImpactTab /> : <UsMarketImpactTab />}
    </div>
  );
}
