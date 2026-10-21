import { useEffect, useState } from 'preact/hooks';

// Expiry is independent of CSS animation so reduced-motion users get the same transient notice.
export function FullscreenHint() {
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    const timer=setTimeout(()=>setVisible(false),4000);
    return ()=>clearTimeout(timer);
  },[]);
  return visible?<div class="tri-fullscreen-hint" role="status">Pressione Esc para sair da tela cheia</div>:null;
}
