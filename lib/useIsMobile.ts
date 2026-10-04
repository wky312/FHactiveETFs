'use client';
import { useEffect, useState } from 'react';

/** 與 globals.css 手機表格規則同一個斷點。掛載後才判斷，SSR 一律當桌機，避免 hydration mismatch。 */
export function useIsMobile(bp = 640): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [bp]);
  return m;
}
