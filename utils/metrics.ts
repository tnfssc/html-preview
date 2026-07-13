import { storage } from 'wxt/utils/storage';

export interface PerformanceMetrics {
  resolveCount: number;
  totalResolveMs: number;
  maximumOutputBytes: number;
  renderCount: number;
  totalHandshakeMs: number;
}

const emptyMetrics: PerformanceMetrics = {
  resolveCount: 0,
  totalResolveMs: 0,
  maximumOutputBytes: 0,
  renderCount: 0,
  totalHandshakeMs: 0,
};

export const performanceMetricsStorage =
  storage.defineItem<PerformanceMetrics>('local:performanceMetrics', {
    fallback: emptyMetrics,
  });

let update = Promise.resolve();

export function recordResolveMetrics(
  resolveMs: number,
  outputBytes: number,
): void {
  if (!metricsAvailable()) return;
  enqueue(async (metrics) => ({
    ...metrics,
    resolveCount: metrics.resolveCount + 1,
    totalResolveMs: metrics.totalResolveMs + finite(resolveMs),
    maximumOutputBytes: Math.max(metrics.maximumOutputBytes, finite(outputBytes)),
  }));
}

export function recordRenderMetrics(handshakeMs: number): void {
  if (!metricsAvailable()) return;
  enqueue(async (metrics) => ({
    ...metrics,
    renderCount: metrics.renderCount + 1,
    totalHandshakeMs: metrics.totalHandshakeMs + finite(handshakeMs),
  }));
}

function enqueue(
  transform: (metrics: PerformanceMetrics) => Promise<PerformanceMetrics>,
): void {
  update = update
    .then(async () => {
      const current = await performanceMetricsStorage.getValue();
      await performanceMetricsStorage.setValue(await transform(current));
    })
    .catch(() => undefined);
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function metricsAvailable(): boolean {
  return (
    !(
      typeof process !== 'undefined' &&
      (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test')
    ) &&
    typeof browser !== 'undefined' &&
    Boolean(browser.runtime?.id)
  );
}
