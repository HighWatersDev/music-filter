export class Utf8Decoder {
  decode(input) {
    if (!input) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }
}

export class Utf8Encoder {
  get encoding() {
    return 'utf-8';
  }

  encode(text = '') {
    const binary = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

globalThis.TextDecoder ??= Utf8Decoder;
globalThis.TextEncoder ??= Utf8Encoder;
