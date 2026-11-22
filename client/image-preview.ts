/** 气泡缩略图 → 面板级预览浮层的跨组件请求（FlatList 行内无法绝对定位浮层）。 */
export interface ImagePreviewRequest {
  uri: string;
  title: string;
}

type Listener = (request: ImagePreviewRequest) => void;

const listeners = new Set<Listener>();

export function requestImagePreview(request: ImagePreviewRequest): void {
  for (const listener of listeners) listener(request);
}

export function onImagePreviewRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}