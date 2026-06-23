'use client';

import { imageStatus, type ImageMeasurementState } from './WzCanvas';

type ImageMeta = {
  imageId: string;
  hand: string;
  finger: string;
  sequenceNumber: number;
  url: string;
};

type Props = {
  sessionId: string;
  images: ImageMeta[];
  measurements: Record<string, ImageMeasurementState>;
};

function fmt(n: number | undefined, decimals = 1): string {
  return n != null ? n.toFixed(decimals) : '—';
}

export function SessionSummary({ sessionId, images, measurements }: Props) {
  const completed = images.filter(
    (img) => imageStatus(measurements[img.imageId] ?? { step: 0 }) === 'complete',
  );

  function handleExport() {
    const exportData = {
      sessionId,
      exportedAt: new Date().toISOString(),
      images: completed.map((img) => {
        const m = measurements[img.imageId];
        return {
          imageId: img.imageId,
          hand: img.hand,
          finger: img.finger,
          sequenceNumber: img.sequenceNumber,
          status: 'complete',
          landmarks: {
            A:    m.pointA,
            B:    m.pointB,
            z25:  m.sidewalls.z25,
            z50:  m.sidewalls.z50,
            z75:  m.sidewalls.z75,
            z100: m.sidewalls.z100,
          },
          measurements: m.result,
        };
      }),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `wz-session-${sessionId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (completed.length === 0) {
    return (
      <div className="text-gray-500 text-sm text-center py-4">
        No measurements complete yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {completed.length} of {images.length} complete
        </span>
        <button
          onClick={handleExport}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium"
        >
          Export JSON
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
              <th className="text-left py-2 pr-3">Hand</th>
              <th className="text-left py-2 pr-3">Finger</th>
              <th className="text-right py-2 pr-3">L px</th>
              <th className="text-right py-2 pr-3">W25</th>
              <th className="text-right py-2 pr-3">W50</th>
              <th className="text-right py-2 pr-3">W75</th>
              <th className="text-right py-2 pr-3">W100</th>
              <th className="text-right py-2 pr-3">Wmax</th>
              <th className="text-right py-2 pr-3">Wmax pos</th>
              <th className="text-right py-2">Ret %</th>
            </tr>
          </thead>
          <tbody>
            {completed.map((img) => {
              const r = measurements[img.imageId]?.result;
              return (
                <tr key={img.imageId} className="border-b border-gray-800 hover:bg-gray-800/40">
                  <td className="py-2 pr-3 text-gray-300 capitalize">{img.hand.toLowerCase()}</td>
                  <td className="py-2 pr-3 text-gray-300 capitalize">{img.finger.toLowerCase()}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-200">{fmt(r?.L_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-200">{fmt(r?.W25_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-200">{fmt(r?.W50_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-200">{fmt(r?.W75_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-200">{fmt(r?.W100_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-blue-300 font-semibold">{fmt(r?.Wmax_px)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-300">{r?.Wmax_position_pct ?? '—'}%</td>
                  <td className="py-2 text-right font-mono text-green-400 font-semibold">{fmt(r?.retention_pct)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
