import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { SessionStore } from '../store';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Local-only camera thumbnails: the native core owns capture. Never enable WebView camera permissions.
// Settings preview viewport: 387x218, recovered CAMERA_VIDEO_PREVIEW (30bab6af3517c471.js).
export function CameraPreview({ bridge, store }: { bridge: Bridge; store: SessionStore }) {
  const id = useRef(crypto.randomUUID());
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const previewId = id.current;
    const off = store.onEvent(event => {
      if ((event.name === 'cameraPreviewFrame' || event.name === 'cameraPreviewClosed') && event.previewId === previewId) {
        if (event.name === 'cameraPreviewFrame') setImage(event.image);
        else { setImage(''); setError(event.reason || 'A prévia foi encerrada.'); }
      }
    });
    bridge.request({name:'startCameraPreview',previewId}).catch(e => { if (live) setError(e.message); });
    const heartbeat = setInterval(() => bridge.send({name:'keepCameraPreview',previewId}),2000);
    return () => { live = false; off(); clearInterval(heartbeat); bridge.send({name:'stopCameraPreview',previewId}); };
  }, [bridge, store]);
  return <div class="tri-camera-preview" role="region" aria-label="Prévia da câmera">
    {image ? <img src={image} alt="Prévia local da câmera"/> : <span role={error ? 'alert' : 'status'}>{error || 'Iniciando câmera…'}</span>}
  </div>;
}

export function CameraPreviewModal({ bridge, store, onClose }: { bridge: Bridge; store: SessionStore; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  return <Modal title="Prévia da câmera" subtitle="Somente você pode ver esta prévia." closing={closing} onClose={close}>
    {!closing && <CameraPreview bridge={bridge} store={store}/>}
  </Modal>;
}
