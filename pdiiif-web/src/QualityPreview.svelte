<script lang="ts">
  import { onMount } from 'svelte';
  import { spring, tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  export let imageData: Uint8Array;
  export let mimeType: string;
  export let waitingForUpdate: boolean;

  const ZOOM_STEP = 0.1;

  let initialView = true;
  let container: HTMLDivElement;
  let viewportCanvas: HTMLCanvasElement;
  let navigatorCanvas: HTMLCanvasElement;
  let viewportCtx: CanvasRenderingContext2D;
  let navigatorCtx: CanvasRenderingContext2D;

  let viewportSettings = spring({ panX: 0, panY: 0, zoom: 1 });

  let image: HTMLImageElement;
  let imageWidth = 0;
  let imageHeight = 0;

  const MAX_ZOOM = 5;
  const MIN_ZOOM = 0.1;

  const blurAmount = tweened(0, {
    duration: 100,
    easing: cubicOut,
  });

  $: if (image && imageData) {
    image.src = URL.createObjectURL(new Blob([imageData], { type: mimeType }));
  }

  $: if (waitingForUpdate) {
    blurAmount.set(5);
  } else {
    blurAmount.set(0);
  }

  onMount(() => {
    viewportCtx = viewportCanvas.getContext('2d')!;
    navigatorCtx = navigatorCanvas.getContext('2d')!;

    viewportSettings.subscribe(() => requestAnimationFrame(draw));

    image = new Image();

    image.onload = () => {
      imageWidth = image.width;
      imageHeight = image.height;
      viewportCanvas.width = container.clientWidth;
      viewportCanvas.height = container.clientHeight;
      let navigatorRatio = navigatorCanvas.height / imageHeight;
      navigatorCanvas.width = imageWidth * navigatorRatio;
      requestAnimationFrame(draw);
      if (initialView) {
        centerImage();
        initialView = false;
      }
    };

    return () => {
      URL.revokeObjectURL(image.src);
    };
  });

  function centerImage(newZoom?: number) {
    viewportSettings.update(
      ({ zoom }) => ({
        panX: (viewportCanvas.width - imageWidth) / 2,
        panY: (viewportCanvas.height - imageHeight) / 2,
        zoom: newZoom ?? zoom,
      }),
      { hard: true }
    );
  }

  function draw() {
    if (!viewportCanvas || !viewportCtx || !navigatorCtx) return;
    viewportCtx.clearRect(0, 0, viewportCanvas.width, viewportCanvas.height);
    viewportCtx.save();
    viewportCtx.translate($viewportSettings.panX, $viewportSettings.panY);
    viewportCtx.scale($viewportSettings.zoom, $viewportSettings.zoom);
    viewportCtx.drawImage(image, 0, 0);
    viewportCtx.restore();

    // Draw thumbnail
    const ratio = Math.min(
      navigatorCanvas.width / imageWidth,
      navigatorCanvas.height / imageHeight
    );
    const thumbWidth = imageWidth * ratio;
    const thumbHeight = imageHeight * ratio;
    navigatorCtx.clearRect(0, 0, navigatorCanvas.width, navigatorCanvas.height);
    navigatorCtx.drawImage(image, 0, 0, thumbWidth, thumbHeight);

    // Draw viewport rectangle on thumbnail
    const rectX =
      (-$viewportSettings.panX / $viewportSettings.zoom) *
      (thumbWidth / imageWidth);
    const rectY =
      (-$viewportSettings.panY / $viewportSettings.zoom) *
      (thumbHeight / imageHeight);
    const rectWidth =
      (viewportCanvas.width / $viewportSettings.zoom) *
      (thumbWidth / imageWidth);
    const rectHeight =
      (viewportCanvas.height / $viewportSettings.zoom) *
      (thumbHeight / imageHeight);
    navigatorCtx.strokeStyle = 'red';
    navigatorCtx.strokeRect(rectX, rectY, rectWidth, rectHeight);
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    updateZoom(delta);
  }

  function handleMouseDown(event: MouseEvent) {
    const startX = event.clientX;
    const startY = event.clientY;
    const startPanX = $viewportSettings.panX;
    const startPanY = $viewportSettings.panY;

    function handleMouseMove(moveEvent: MouseEvent) {
      viewportSettings.update(({ zoom }) => ({
        panX: startPanX + moveEvent.clientX - startX,
        panY: startPanY + moveEvent.clientY - startY,
        zoom,
      }));
    }

    function handleMouseUp() {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function handleNavigatorMouseDown(event: MouseEvent) {
    const rect = navigatorCanvas.getBoundingClientRect();
    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;

    const startX = (event.clientX - rect.left) * scaleX;
    const startY = (event.clientY - rect.top) * scaleY;

    const startPanX = $viewportSettings.panX;
    const startPanY = $viewportSettings.panY;

    const relativeX = startX + startPanX / $viewportSettings.zoom;
    const relativeY = startY + startPanY / $viewportSettings.zoom;

    function handleMouseMove(moveEvent: MouseEvent) {
      const x = (moveEvent.clientX - rect.left) * scaleX;
      const y = (moveEvent.clientY - rect.top) * scaleY;

      viewportSettings.update(({ zoom }) => ({
        panX: (relativeX - x) * zoom,
        panY: (relativeY - y) * zoom,
        zoom,
      }));
    }

    function handleMouseUp() {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function updateZoom(increment: number) {
    const oldZoom = $viewportSettings.zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom + increment));

    const viewportCenterX = viewportCanvas.width / 2;
    const viewportCenterY = viewportCanvas.height / 2;

    const zoomRatio = newZoom / oldZoom;

    viewportSettings.update(
      ({ panX, panY }) => ({
        panX: viewportCenterX - (viewportCenterX - panX) * zoomRatio,
        panY: viewportCenterY - (viewportCenterY - panY) * zoomRatio,
        zoom: newZoom,
      }),
      { hard: true }
    );
  }

  function resetViewport() {
    centerImage(1);
  }
</script>

<div bind:this={container} class="h-64 w-full relative overflow-hidden">
  <canvas
    style:filter="blur({$blurAmount}px)"
    bind:this={viewportCanvas}
    on:wheel={handleWheel}
    on:mousedown={handleMouseDown}
    class="w-full h-full"
  ></canvas>
  <div
    class="absolute top-2 right-2 w-24 h-18 border-2 border-white shadow-md overflow-hidden"
  >
    <canvas
      bind:this={navigatorCanvas}
      width={100}
      height={75}
      on:mousedown={handleNavigatorMouseDown}
      class="w-full h-full bg-white"
    ></canvas>
    <div class="flex justify-between p-1 bg-white">
      <button
        class="w-6 h-6 bg-orange-200 rounded-full"
        on:click={() => updateZoom(-ZOOM_STEP)}>-</button
      >
      <button class="w-6 h-6 bg-gray-200 rounded-full" on:click={resetViewport}
        >↻</button
      >
      <button
        class="w-6 h-6 bg-blue-200 rounded-full"
        on:click={() => updateZoom(ZOOM_STEP)}>+</button
      >
    </div>
  </div>
</div>

<style>
  canvas {
    image-rendering: high-quality;
    transition: filter 0.3s ease-out;
  }
</style>
