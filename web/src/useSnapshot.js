import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api.js';

// 快照订阅：SSE 只发轻量 refresh 信号，收到后拉全量快照；另带 30s 兜底轮询
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState(null);
  const [connected, setConnected] = useState(false);
  const fetching = useRef(false);
  const pendingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (fetching.current) {
      pendingRef.current = true; // 有请求在飞行：记下，等它回来补一次
      return;
    }
    fetching.current = true;
    try {
      const { ok, data } = await api.get('/api/snapshot');
      if (ok && data?.snapshot) setSnapshot(data.snapshot);
    } catch {
      /* 网络抖动，等下次信号 */
    } finally {
      fetching.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        load(); // 尾随重取：不丢这次刷新信号
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', () => setConnected(true));
    es.addEventListener('refresh', () => refresh());
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const poll = setInterval(refresh, 30000);
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return { snapshot, connected, refresh };
}
