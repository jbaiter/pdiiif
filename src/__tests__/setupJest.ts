/* eslint-disable-next-line @typescript-eslint/no-var-requires */
require('jest-fetch-mock').enableMocks();
// Polyfill for encoding which isn't present globally in jsdom
import { TextEncoder, TextDecoder } from 'util'
(global as any).TextEncoder = TextEncoder;
(global as any).TextDecoder = TextDecoder;