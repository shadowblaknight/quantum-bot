import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';

function buildEquityCurve(ledger, startBalance) {
  if (!ledger?.length) return [];
  const sorted = [...ledger]
    .filter(t => t.finalPnL != null && t.closedAt)
    .sort((a, b) => a.closedAt - b.closedAt);
  if (!sorted.length) return [];
  let equity = startBalance || 100000;
  const seen = new Set();
  return sorted
    .map(t => {
      equity += (t.finalPnL || 0);
      // LightweightCharts time must be unique and ascending (seconds)
      let ts = Math.floor(t.closedAt / 1000);
      while (seen.has(ts)) ts++;
      seen.add(ts);
      return { time: ts, value: +equity.toFixed(2) };
    });
}

export default function EquityChart({ ledger, capital }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#7070A0',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1A1A2E' },
        horzLines: { color: '#1A1A2E' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#1A1A2E', minimumWidth: 60 },
      timeScale: { borderColor: '#1A1A2E', timeVisible: true, secondsVisible: false },
      handleScale: { axisPressedMouseMove: false },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor:   '#D4A017',
      topColor:    'rgba(212,160,23,0.14)',
      bottomColor: 'rgba(212,160,23,0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });

    chartRef.current = { chart, series };

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const data = buildEquityCurve(ledger, capital);
    if (!data.length) return;
    chartRef.current.series.setData(data);
    chartRef.current.chart.timeScale().fitContent();
  }, [ledger, capital]);

  return (
    <div className="eq-chart-wrap">
      <div className="eq-chart-inner" ref={containerRef} />
    </div>
  );
}
