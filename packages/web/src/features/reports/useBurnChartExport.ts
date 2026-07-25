import type { RefObject } from 'react';
import type { BurnVariant } from './hooks/useBurnChart';

/**
 * PNG / PDF export of the rendered chart node.
 *
 * `html-to-image` and `jspdf` are imported lazily inside the handlers so neither
 * lands in the main bundle for the (common) case where nobody exports.
 */
export function useBurnChartExport(
  chartRef: RefObject<HTMLDivElement | null>,
  variant: BurnVariant,
  today: string,
) {
  const exportPng = async () => {
    const { toPng } = await import('html-to-image');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `burn-${variant}-${today}.png`;
    a.click();
  };

  const exportPdf = async () => {
    const { toPng } = await import('html-to-image');
    const { jsPDF } = await import('jspdf');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((res) => {
      img.onload = () => res();
    });
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [img.width, img.height],
    });
    pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
    pdf.save(`burn-${variant}-${today}.pdf`);
  };

  return { exportPng, exportPdf };
}
