declare module 'heic-convert' {
  type HeicConvertInput = {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  };

  export default function heicConvert(input: HeicConvertInput): Promise<Buffer | Uint8Array>;
}
