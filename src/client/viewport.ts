import { useEffect } from 'react';

/** One page-wide, coalesced layout subscription. No React/output state and no hidden terminal renderer. */
export function useViewportLayout() {
  useEffect(() => {
    const root = document.documentElement, viewport = window.visualViewport;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (document.visibilityState !== 'visible') return;
      const height = Math.max(160, Math.round(viewport?.height ?? window.innerHeight));
      root.style.setProperty('--pt-viewport-height', `${height}px`);
      root.style.setProperty('--pt-viewport-top', `${Math.max(0, Math.round(viewport?.offsetTop ?? 0))}px`);
      root.dataset.ptCompact = height < 500 || window.innerHeight - height > 120 ? 'true' : 'false';
    };
    const schedule = () => { if (!frame && document.visibilityState === 'visible') frame = requestAnimationFrame(apply); };
    const visibility = () => {
      if (document.visibilityState === 'visible') schedule();
      else { if (frame) cancelAnimationFrame(frame); frame = 0; }
    };
    viewport?.addEventListener('resize', schedule); viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule); window.addEventListener('pageshow', schedule);
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule); viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule); window.removeEventListener('pageshow', schedule);
      document.removeEventListener('visibilitychange', visibility);
      root.style.removeProperty('--pt-viewport-height'); root.style.removeProperty('--pt-viewport-top'); delete root.dataset.ptCompact;
    };
  }, []);
}
