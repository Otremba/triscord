import type { Bridge } from './bridge';
import type { ShareSource } from './protocol';
import type { SessionStore } from './store';

export type ShareSourceState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; generation: string; sources: ShareSource[] };

// Subscribe before requesting: the core can deliver thumbnails before its reply.
export function loadShareSources(
  bridge: Pick<Bridge, 'request'>,
  store: Pick<SessionStore, 'onEvent'>,
  update: (state: ShareSourceState) => void,
  thumbnail: (index: number, image: string) => void,
): () => void {
  let active = true;
  let generation: string | null = null;
  const early = new Map<string, Map<number, string>>();
  update({ status: 'loading' });
  const off = store.onEvent(event => {
    if (!active || event.name !== 'shareThumbnail') return;
    if (event.generation === generation) thumbnail(event.index, event.image);
    else if (generation === null) {
      const images = early.get(event.generation) ?? new Map<number, string>();
      images.set(event.index, event.image);
      early.set(event.generation, images);
    }
  });
  void bridge.request<{ generation: string; sources: ShareSource[] }>({ name: 'listShareSources' })
    .then(value => {
      if (!active) return;
      generation = value.generation;
      for (const [index, image] of early.get(generation) ?? []) thumbnail(index, image);
      early.clear();
      update({ status: 'ready', generation: value.generation, sources: value.sources });
    })
    .catch((error: unknown) => {
      if (!active) return;
      early.clear();
      off();
      update({ status: 'error', message: error instanceof Error ? error.message : 'Tente novamente.' });
    });
  return () => { active = false; off(); early.clear(); };
}
