export function findStreamForMedia({ streams, objectUrls, taggedMediaSourceId, src }) {
  const isMatch = taggedMediaSourceId
    ? (stream) => String(stream.mediaSourceId) === String(taggedMediaSourceId)
    : (stream) => Boolean(src) && objectUrls.get(stream.mediaSourceId) === src;
  let match = null;
  for (const stream of streams) if (isMatch(stream)) match = stream;
  return match;
}
