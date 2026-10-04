declare module 'bs58' {
  interface BaseConverter {
    encode(buffer: Uint8Array | number[]): string;
    decode(str: string): Uint8Array;
    decodeUnsafe(str: string): Uint8Array | undefined;
  }
  const bs58: BaseConverter;
  export default bs58;
}
