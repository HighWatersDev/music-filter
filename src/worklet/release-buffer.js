// Detaching frees the backing store at once. Dropping the reference would wait for a full collection,
// which an audio worklet that barely allocates may not run for a long time.
export function releaseBuffer(buffer) {
  try {
    buffer?.transfer?.(0);
  } catch {}
}
