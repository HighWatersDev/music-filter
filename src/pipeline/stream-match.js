export function findStreamForMedia({ streams, objectUrls, taggedMediaSourceId, src }) {
  const isMatch = taggedMediaSourceId
    ? (stream) => String(stream.mediaSourceId) === String(taggedMediaSourceId)
    : (stream) => Boolean(src) && objectUrls.get(stream.mediaSourceId) === src;
  let match = null;
  for (const stream of streams) if (isMatch(stream)) match = stream;
  return match;
}

export function streamProblem({ mime, timestampOffset }) {
  if (timestampOffset) return 'timestamp offset';
  const codecs = /codecs\s*=\s*"?([^";]*)/i.exec(mime)?.[1];
  const isWebm = /^\s*audio\/webm\b/i.test(mime);
  if (!isWebm || (codecs && !/^\s*opus\s*$/i.test(codecs))) return `unsupported audio type ${mime}`;
  return null;
}
