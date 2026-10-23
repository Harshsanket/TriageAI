import { useEffect, useState } from 'react';

interface HwSnapshot {
  capturedAt: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: number[];
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
  queuePending: number;
  queueProcessing: number;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

export default function SystemPage() {
  const [hw, setHw] = useState<HwSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/system/hw');
        if (!res.ok) throw new Error(`hw metrics failed (${res.status})`);
        const data = (await res.json()) as HwSnapshot;
        if (!disposed) setHw(data);
      } catch (err) {
        if (!disposed) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section>
      <h2>System</h2>
      {error && <p role="alert">{error}</p>}
      {!hw && !error && <p>Loading hardware metrics…</p>}
      {hw && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <th align="left">Uptime</th>
              <td>
                {Math.floor(hw.uptimeSec / 60)}m {hw.uptimeSec % 60}s
              </td>
            </tr>
            <tr>
              <th align="left">CPU / load</th>
              <td>
                {hw.cpuCount} cores · load {hw.loadAvg.join(' / ')}
              </td>
            </tr>
            <tr>
              <th align="left">Memory (host)</th>
              <td>
                {mb(hw.memoryTotalBytes - hw.memoryFreeBytes)} used of {mb(hw.memoryTotalBytes)}
              </td>
            </tr>
            <tr>
              <th align="left">Process</th>
              <td>
                RSS {mb(hw.processRssBytes)} · heap {mb(hw.processHeapUsedBytes)}
              </td>
            </tr>
            <tr>
              <th align="left">Queue backlog</th>
              <td>
                {hw.queuePending} pending · {hw.queueProcessing} processing
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
