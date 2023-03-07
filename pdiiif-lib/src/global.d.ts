export {}

declare global {
  interface Uint8Array {
    findLastIndex(
      predicate: (value: number, index: number, obj: number[]) => unknown,
      thisArg?: any
    ): number
  }
}