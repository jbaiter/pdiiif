import UAParser from 'ua-parser-js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Determine the safe maximum size for Blobs. */
export function getMaximumBlobSize(): number {
  // The logic used here is lifted from MEGA's web downloader:
  // https://github.com/meganz/webclient/blob/master/js/transfers/meths/memory.js#L219-L251
  const ua = UAParser();
  if (ua.device.type === 'mobile' || ua.device.type === 'tablet') {
    if (
      ua.os.name === 'iOS' &&
      (ua.browser.name === 'Chrome' || ua.browser.name === 'Firefox')
    ) {
      // Chrome/Firefox on iOS only support very small Blobs
      return 1.3 * MIB;
    }
    // Keep it safe for other mobile devices, since we don't know
    // how much RAM they have (FIXME: Maybe for Chrome via navigator.deviceMemory?)
    return 100 * MIB;
  } else if (ua.engine.name === 'Trident' || ua.engine.name === 'Edge') {
    return 600 * MIB;
  } else {
    return ((navigator as any).deviceMemory || 1) * GIB;
  }
}

export function supportsStreamsaver(): boolean {
  try {
    // Streamsaver needs ReadableStream and service worker support
    new Response(new ReadableStream());
    if (isSecureContext && !('serviceWorker' in navigator)) {
      return false;
    }
  } catch (err) {
    return false;
  }
  return true;
}

export function buildCanvasFilterString(allIdentifiers: string[], filteredIdentifiers?: string[]): string | undefined {
  if (!filteredIdentifiers?.length) {
    return undefined;
  }
  let parts = [];
  let currentRange: number[] = [];
  for (const ident of filteredIdentifiers) {
    const idx = allIdentifiers.indexOf(ident);
    if (currentRange.length < 2) {
      // New range
      currentRange.push(idx);
    } else if (currentRange[1] === idx - 1) {
      // Extend range
      currentRange.push(idx);
    } else {
      // Finish range
      if (currentRange.length == 1) {
        parts.push(currentRange[0].toString());
      } else if (currentRange[0] + 1 === currentRange[1]) {
        parts.push(currentRange[0].toString());
        parts.push(currentRange[1].toString());
      } else {
        parts.push(currentRange.join('-'));
      }
      currentRange = [idx];
    }
  }
  return parts.join(',');
}