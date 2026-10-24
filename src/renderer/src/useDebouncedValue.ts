import { useEffect, useState } from 'react'

// Returns a copy of `value` that only changes after the input has been stable
// for `delayMs`. The data grid used to issue a query on every keystroke, so a
// ten-character search ran ten queries, each one slower than the last.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
