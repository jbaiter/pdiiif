<script lang="ts">
  export let currentProgress: { current: number; total: number };

  $: progressPercent = (currentProgress.current / currentProgress.total) * 100;
  $: progressStyle = `width: ${progressPercent}%`;
</script>

<div
  class="relative mt-4 h-8 w-full rounded-md bg-white border-2 border-white"
>
  <div style={progressStyle} class="h-full rounded-md bg-blue-600" />
  <div
    class="absolute w-full top-0 pt-1 text-center text-white mix-blend-difference"
  >
    <slot />
  </div>
</div>
