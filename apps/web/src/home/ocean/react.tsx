'use client';

import { useEffect, useRef } from 'react';
import { OceanEngine } from './engine';
import type { SharkSpec } from './world';

/** Glyphs come from the canvas's font-family, so give it (or a parent) a monospace font. */
export function AsciiOcean({
  className,
  sharks,
  paused = false,
}: {
  className?: string;
  sharks?: SharkSpec[];
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OceanEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The engine needs both observers; jsdom has neither, and canvas support
    // is partial there, so skip the art instead of logging a context error.
    if (typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined')
      return;
    try {
      const engine = new OceanEngine(canvas, sharks);
      engine.setPaused(paused);
      engineRef.current = engine;
      return () => {
        engineRef.current = null;
        engine.destroy();
      };
    } catch {
      // Restricted canvas environments have no 2D context; skip the art.
      return;
    }
    // The roster is fixed for the life of the canvas.
  }, []);

  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-paused={paused ? 'true' : 'false'}
      className={`ascii-ocean ${className ?? ''}`}
    />
  );
}
