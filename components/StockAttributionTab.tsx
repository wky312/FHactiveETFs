'use client';
import { useState, useEffect } from 'react';
import AttributionTab from './AttributionTab';
import OverseasAttributionTab from './OverseasAttributionTab';

const SUB    = '#6B6460';
const BORDER = '#E8E3DF';
const CARD   = '#FFFFFF';
const UP     = '#C00000';
const SANS   = "'Noto Sans TC', 'Segoe UI', Arial, sans-serif";

type Scope = 'domestic' | 'overseas';

function segBtn(active: boolean): React.CSSProperties {
  return {
    padding: '8px 22px', background: active ? UP : CARD, color: active ? '#fff' : SUB,
    border: `1px solid ${active ? UP : BORDER}`, borderRadius: 999, cursor: 'pointer',
    fontSize: '.86rem', fontWeight: 700, fontFamily: SANS,
  };
}

/* 合併「國內個股歸因」＋「海外個股歸因」成一頁，內部用台股／海外切換，
   避免頂部導覽塞太多分頁。舊分享連結 ?tab=attribution / oseasattr 仍可正確還原範圍
   （在 Dashboard 把 tab 改寫成 'stockattr' 之前，這裡的初次渲染還讀得到舊值）。 */
export default function StockAttributionTab() {
  const sp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const legacyTab = sp0?.get('tab');
  const initScope: Scope =
    sp0?.get('scope') === 'overseas' ? 'overseas' :
    sp0?.get('scope') === 'domestic' ? 'domestic' :
    legacyTab === 'oseasattr' ? 'overseas' : 'domestic';
  const [scope, setScope] = useState<Scope>(initScope);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.set('tab', 'stockattr'); sp.set('scope', scope);
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  }, [scope]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <button onClick={() => setScope('domestic')} style={segBtn(scope === 'domestic')}>台股個股歸因</button>
        <button onClick={() => setScope('overseas')} style={segBtn(scope === 'overseas')}>美股／海外個股歸因</button>
      </div>
      {scope === 'domestic' ? <AttributionTab /> : <OverseasAttributionTab />}
    </div>
  );
}
