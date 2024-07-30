import encode, { init as initMozJpegEnc } from '@jsquash/jpeg/encode';

import {
  BrowserEncoderParams,
  InitializationRequest,
  MOZJPEG_DEFAULT_PARAMS,
  MozJPEGParams,
  OptimizationError,
  OptimizationRequest,
  OptimizedImage,
  TaskDescription,
  type WorkerMessage,
} from './optimization';

let mozjpegInitialized = false;
const canvas = new OffscreenCanvas(1, 1);

self.onmessage = async function (
  evt: MessageEvent<TaskDescription<OptimizationRequest | InitializationRequest>>
) {
  if ('mozjpegWasm' in evt.data.data) {
    console.debug(`worker: received MozJPEG WASM module`);
    const module = await WebAssembly.compile(evt.data.data.mozjpegWasm);
    await initMozJpegEnc(module);
    mozjpegInitialized = true;
    console.debug(`worker: initialized MozJPEG encoder`);
    self.postMessage({
      input: evt.data,
      result: {},
    });
    return;
  }

  const params = evt.data.data;
  console.debug(`worker: received optimization task`, evt.data.id, params);
  let optimizedData: Uint8Array;
  try {
    if (params.method === 'mozjpeg') {
      if (!mozjpegInitialized) {
        throw new Error('MozJPEG encoder not initialized');
      }
      optimizedData = await reencodeWithMozJPEG(params);
    } else if (params.method === 'browser') {
      optimizedData = await reencodeWithBrowserEncoder(params);
    } else {
      throw new Error('Unsupported optimization method');
    }
  } catch (err) {
    console.error(`Failed to optimize image: ${err}`, evt.data.id, err);
    self.postMessage(
      new OptimizationError(
        `Failed to optimize image: ${err}`,
        evt.data.id,
        err
      )
    );
    return;
  }
  const result = {
    input: evt.data,
    result: {
      jpegData: optimizedData,
      sizeFactor: optimizedData.length / params.imageData.length,
    },
  };
  self.postMessage(result);
  console.debug(`worker optimized image with factor ${result.result.sizeFactor}`);
};

function loadImageToCanvas(
  imageData: Uint8Array,
  imageFormat: string
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const bitmap = await createImageBitmap(
        new Blob([imageData], { type: imageFormat })
      );
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get 2D context'));
        return;
      }
      ctx.drawImage(bitmap, 0, 0);
      resolve();
    } catch (err) {
      reject(err);
      return;
    }
  });
}

async function reencodeWithMozJPEG(
  params: OptimizationRequest & MozJPEGParams
): Promise<Uint8Array> {
  await loadImageToCanvas(params.imageData, params.imageFormat);
  const pixelData = canvas
    .getContext('2d')!
    .getImageData(0, 0, canvas.width, canvas.height);
  const encoded = await encode(pixelData, {
    ...MOZJPEG_DEFAULT_PARAMS,
    ...params,
  });
  return new Uint8Array(encoded);
}

async function reencodeWithBrowserEncoder(
  params: OptimizationRequest & BrowserEncoderParams
): Promise<Uint8Array> {
  await loadImageToCanvas(params.imageData, params.imageFormat);
  const encoded = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: params.quality / 100,
  });
  return new Uint8Array(await encoded.arrayBuffer());
}
