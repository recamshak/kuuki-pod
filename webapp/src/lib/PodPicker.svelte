<script lang="ts">
  /*
   * The Pod picker (ticket 12e): the header's primary navigation, replacing the
   * native <select> and the two old buttons. A custom dropdown was needed over a
   * native <select> for two reasons the platform can't give us: a per-row status
   * disc, and — critically — a real user click on the "Connect a Pod" row, since
   * calling requestDevice() from a <select>'s change event risks failing Web
   * Bluetooth's user-gesture check.
   *
   * It is deliberately dumb (ADR-0004's untestable UI seam): it takes the Pod list
   * + selected id as props and emits select / connect / forget / rename intents. It
   * owns no lifecycle — all state lives in Fleet/the parent. What it *does* own is
   * the accessibility a native <select> gave for free: keyboard navigation, focus
   * management, click-outside / Escape to close, and aria-expanded/roles.
   */

  /** One row of the picker: a known Pod with its resolved name and live state. */
  export interface PickerPod {
    /** Stable per-Pod key (passed back through the callbacks). */
    id: string;
    /** Human-readable label, resolved by the parent via names.ts. */
    name: string;
    /** Whether the Pod currently has a live connection (green vs orange disc). */
    connected: boolean;
  }

  interface Props {
    /** Every known Pod, in display order. */
    pods: PickerPod[];
    /** The focused Pod's id, or null when none is selected / zero Pods. */
    selectedId: string | null;
    /** Focus a Pod. Closes the menu. */
    onSelect: (id: string) => void;
    /** Begin connecting a new Pod — fired from a real click (valid Web Bluetooth gesture). */
    onConnect: () => void;
    /** Forget a Pod for good (the parent confirms nothing; this component does). */
    onForget: (id: string) => void;
    /** Rename a Pod (the parent runs the prompt + names.ts write). */
    onRename: (id: string) => void;
  }

  let { pods, selectedId, onSelect, onConnect, onForget, onRename }: Props =
    $props();

  let open = $state(false);
  let trigger: HTMLButtonElement;
  let menu = $state<HTMLDivElement>();

  const selectedPod = $derived(
    pods.find((p) => p.id === selectedId) ?? null,
  );

  function toggle(): void {
    open ? close() : openMenu();
  }

  function openMenu(): void {
    open = true;
  }

  function close(returnFocus = false): void {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function choose(id: string): void {
    onSelect(id);
    close(true);
  }

  function connect(): void {
    // The click that reached here is the user gesture requestDevice() needs.
    close();
    onConnect();
  }

  function forget(pod: PickerPod): void {
    // Confirm before forgetting: it deletes the Pod's data and revokes the grant.
    const message = `Forget "${pod.name}"? This erases its stored history and revokes this browser's access to the Pod.`;
    if (confirm(message)) onForget(pod.id);
  }

  // Open the menu from the trigger with a down-arrow, the way a native menu does
  // (Enter/Space already open it via the button's native click).
  function onTriggerKeydown(event: KeyboardEvent): void {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openMenu();
    }
  }

  // The roving-focus targets, in DOM order: every [data-menuitem] inside the menu.
  function items(): HTMLElement[] {
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>("[data-menuitem]"));
  }

  function focusAt(index: number): void {
    const els = items();
    if (els.length === 0) return;
    const wrapped = ((index % els.length) + els.length) % els.length;
    els[wrapped].focus();
  }

  function focusRelative(delta: number): void {
    const els = items();
    const current = els.indexOf(document.activeElement as HTMLElement);
    focusAt(current === -1 ? 0 : current + delta);
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRelative(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRelative(-1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(-1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
    }
  }

  // On open, move focus into the menu (the selected row, else the first item), and
  // wire the outside-click / focus-loss dismissal. Runs after the menu renders.
  $effect(() => {
    if (!open || !menu) return;

    const selectedButton = menu.querySelector<HTMLElement>(
      "[data-menuitem][data-selected='true']",
    );
    (selectedButton ?? items()[0])?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu?.contains(target) && !trigger.contains(target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  });
</script>

<!-- A status disc: green connected / orange disconnected, labelled for non-sighted use. -->
{#snippet disc(connected: boolean)}
  {@const state = connected ? "connected" : "disconnected"}
  <span class="disc" class:connected title={state} aria-label={state}></span>
{/snippet}

<div class="picker">
  <button
    class="trigger"
    bind:this={trigger}
    onclick={toggle}
    onkeydown={onTriggerKeydown}
    aria-haspopup="menu"
    aria-expanded={open}
  >
    {#if selectedPod}
      {@render disc(selectedPod.connected)}
      <span class="label">{selectedPod.name}</span>
    {:else}
      <span class="label muted">Connect a Pod</span>
    {/if}
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div
      class="menu"
      role="menu"
      tabindex="-1"
      aria-label="Pods"
      bind:this={menu}
      onkeydown={onMenuKeydown}
    >
      {#each pods as pod (pod.id)}
        <div class="row" class:selected={pod.id === selectedId}>
          <button
            class="select"
            role="menuitemradio"
            aria-checked={pod.id === selectedId}
            data-menuitem
            data-selected={pod.id === selectedId}
            tabindex="-1"
            onclick={() => choose(pod.id)}
          >
            {@render disc(pod.connected)}
            <span class="label">{pod.name}</span>
          </button>
          <button
            class="icon"
            role="menuitem"
            data-menuitem
            tabindex="-1"
            title="Rename"
            aria-label={`Rename ${pod.name}`}
            onclick={() => onRename(pod.id)}
          >
            ✎
          </button>
          <button
            class="icon"
            role="menuitem"
            data-menuitem
            tabindex="-1"
            title="Forget"
            aria-label={`Forget ${pod.name}`}
            onclick={() => forget(pod)}
          >
            ✕
          </button>
        </div>
      {/each}

      <button
        class="connect"
        role="menuitem"
        data-menuitem
        tabindex="-1"
        onclick={connect}
      >
        + Connect a Pod
      </button>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: inline-block;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: #161b22;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    font-size: 0.95rem;
    cursor: pointer;
  }

  .trigger:hover {
    background: #1c2129;
  }

  .caret {
    opacity: 0.6;
    font-size: 0.75rem;
  }

  .menu {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 10;
    min-width: max(220px, 100%);
    display: flex;
    flex-direction: column;
    padding: 0.3rem;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.6);
  }

  .row {
    display: flex;
    align-items: stretch;
    gap: 0.15rem;
    border-radius: 6px;
  }

  .row.selected {
    background: #21262d;
  }

  .select {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    color: #e6edf3;
    border-radius: 6px;
    padding: 0.45rem 0.5rem;
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
  }

  .icon {
    background: none;
    border: none;
    color: #8b949e;
    border-radius: 6px;
    padding: 0 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .connect {
    margin-top: 0.2rem;
    background: none;
    border: none;
    border-top: 1px solid #21262d;
    color: #58a6ff;
    border-radius: 0 0 6px 6px;
    padding: 0.5rem;
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
  }

  .select:hover,
  .icon:hover,
  .connect:hover,
  .select:focus-visible,
  .icon:focus-visible,
  .connect:focus-visible {
    background: #2a3038;
    outline: none;
  }

  .icon:hover,
  .icon:focus-visible {
    color: #e6edf3;
  }

  .disc {
    flex: none;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #d29922; /* orange: disconnected */
  }

  .disc.connected {
    background: #3fb950; /* green: connected */
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    opacity: 0.65;
  }
</style>
