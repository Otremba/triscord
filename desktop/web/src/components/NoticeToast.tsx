import { useEffect, useState } from 'preact/hooks';
import '../styles/notice.css';

// Notices from the Rust core ("O servidor recusou a operação", a command that failed): the bridge raises them as
// 'tri-preview-notice' events. The C++ core only logs its notices, so the interface never needed a place for them.
// One at a time, replaced by the next, gone after 7 s or on dismissal.
export function NoticeToast() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    const show = (event: Event) => setMessage(String((event as CustomEvent).detail ?? '').slice(0, 300));
    addEventListener('tri-preview-notice', show);
    return () => removeEventListener('tri-preview-notice', show);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 7000);
    return () => clearTimeout(timer);
  }, [message]);
  if (!message) return null;
  return (
    <div class="tri-notice" role="alert">
      <span class="tri-notice__text">{message}</span>
      <button class="tri-notice__close" aria-label="Fechar aviso" onClick={() => setMessage('')}>×</button>
    </div>
  );
}
