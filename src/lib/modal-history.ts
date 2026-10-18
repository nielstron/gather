import { pushState, replaceState } from '$app/navigation';
import { page as currentPage } from '$app/state';
import { page } from '$app/stores';

const active = new Set<string>();
let pendingBack: Promise<void> | undefined;

/** One shallow history entry per modal, shared by native dialogs and the viewer. */
export function trackModalHistory(close: () => void): () => void {
  const id = crypto.randomUUID();
  let released = false;
  let unsubscribe = () => {};
  function register() {
    if (released) return;
    active.add(id);
    const state = currentPage.state;
    pushState('', { ...state, modalIds: [...active] });
    let initial = true;
    unsubscribe = page.subscribe(({ state }) => {
      // The legacy store emits its previous snapshot before the shallow update flushes.
      if (initial) { initial = false; return; }
      if (state.modalIds?.includes(id)) return;
      released = true;
      active.delete(id);
      unsubscribe();
      close();
    });
  }
  // Closing a modal uses asynchronous browser traversal. A rapidly opened next
  // modal must wait for that traversal, rather than be closed by its popstate.
  if (pendingBack) void pendingBack.then(register);
  else register();
  return () => {
    if (released) return;
    released = true;
    active.delete(id);
    unsubscribe();
    const state = currentPage.state;
    const ids = state.modalIds || [];
    if (ids.at(-1) === id) {
      let complete!: () => void;
      const completion = new Promise<void>(resolve => { complete = resolve; });
      pendingBack = completion;
      let initial = true;
      const stop = page.subscribe(({ state }) => {
        if (initial) { initial = false; return; }
        if (state.modalIds?.includes(id)) return;
        stop();
        if (pendingBack === completion) pendingBack = undefined;
        complete();
      });
      history.back();
    } else if (ids.includes(id)) {
      replaceState('', { ...state, modalIds: ids.filter(value => value !== id) });
    }
  };
}

/** Apply to every native modal dialog; tracks showModal, close, Escape and saves. */
export function modalHistory(dialog: HTMLDialogElement) {
  let release: (() => void) | undefined;
  function sync() {
    if (dialog.open && !release) release = trackModalHistory(() => dialog.close());
    else if (!dialog.open && release) { const finish = release; release = undefined; finish(); }
  }
  const observer = new MutationObserver(sync);
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  dialog.addEventListener('close', sync);
  sync();
  return { destroy() { observer.disconnect(); dialog.removeEventListener('close', sync); release?.(); } };
}
