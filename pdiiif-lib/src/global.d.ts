export {}

declare global {
  interface Uint8Array {
    findLastIndex(
      predicate: (value: number, index: number, obj: Uint8Array) => unknown,
      thisArg?: any
    ): number
  }
}