import { useCallback, useEffect, useState } from 'react';

// FE-C5: count down to an absolute deadline instead of decrementing once per
// tick. Background tabs throttle timers (down to once a minute), so a counter
// based on `countdown - 1` drifts behind the server's actual expiry; recomputing
// from `Date.now()` stays correct whenever the timer finally runs.
export function useCountdown() {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (deadline === null) {
      setCountdown(0);
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0 && timer !== undefined) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const start = useCallback((seconds: number) => {
    setDeadline(seconds > 0 ? Date.now() + seconds * 1000 : null);
  }, []);

  return { countdown, start };
}
