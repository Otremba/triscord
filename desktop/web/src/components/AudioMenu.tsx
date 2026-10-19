import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { suspendOverlays } from '../video';
import { usePopoutAnimation } from './popoutAnimation';
type Device='input'|'output';
type Open={anchor:HTMLElement;device:Device};
export function openAudioMenu(anchor:HTMLElement,device:Device){dispatchEvent(new CustomEvent<Open>('tri-open-audio-menu',{detail:{anchor,device}}));}
export function AudioMenuHost({session,bridge}:{session:Session;bridge:Bridge}){
  const [open,setOpen]=useState<Open|null>(null);const close=useCallback(()=>setOpen(null),[]);
  useEffect(()=>{const onOpen=(e:Event)=>setOpen((e as CustomEvent<Open>).detail);addEventListener('tri-open-audio-menu',onOpen);return()=>removeEventListener('tri-open-audio-menu',onOpen);},[]);
  useEffect(close,[session.selectedServerId]);
  return open?<AudioMenu {...open} session={session} bridge={bridge} close={close}/>:null;
}
// ACCOUNT_PANEL.md: 222px popover, 52px device row, 58px volume row; device submenu 208px.
function AudioMenu({anchor,device,session,bridge,close}:Open&{session:Session;bridge:Bridge;close:()=>void}){
  const root=useRef<HTMLDivElement>(null),[submenu,setSubmenu]=useState(false),[error,setError]=useState('');
  const [pos,setPos]=useState({left:8,top:8});
  const input=device==='input',settings=session.settings;
  const choices=[{id:'',name:'Padrão do Windows'},...(input?settings?.inputDevices:settings?.outputDevices)??[]];
  const selected=(input?settings?.inputDevice:settings?.outputDevice)??'';
  const value=(input?settings?.inputVolume:settings?.outputVolume)??100,max=input?100:200;
  const current=choices.find(x=>x.id===selected)?.name??'Dispositivo Indisponível';
  useLayoutEffect(()=>{const place=()=>{const r=(anchor.closest('.tri-split')??anchor).getBoundingClientRect(),h=root.current?.offsetHeight??166;setPos({left:Math.max(8,Math.min(r.left,innerWidth-230)),top:Math.max(8,r.top-h-4)});};place();addEventListener('resize',place);return()=>removeEventListener('resize',place);},[anchor]);
  useEffect(()=>{
    bridge.send({name:'requestDevices'});suspendOverlays(true);anchor.setAttribute('aria-expanded','true');
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))close();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();close();}};
    addEventListener('pointerdown',outside);addEventListener('keydown',key,true);
    return()=>{removeEventListener('pointerdown',outside);removeEventListener('keydown',key,true);suspendOverlays(false);anchor.setAttribute('aria-expanded','false');if(anchor.isConnected)anchor.focus();};
  },[anchor,bridge,close]);
  const set=(key:'inputDevice'|'outputDevice'|'inputVolume'|'outputVolume',value:string|number)=>{
    setError('');bridge.request({name:'setSetting',key,value} as Parameters<Bridge['request']>[0]).catch(e=>setError(e.message));
  };
  const anim = usePopoutAnimation('fade', 'top');   // Discord Popout: FADE (filmed), above its button
  return <div ref={root} class={`tri-audio-menu ${anim.className}`} data-popout-animating={anim['data-popout-animating']} role="dialog" aria-label={input?'Opções de entrada':'Opções de saída'} style={pos}>
    <button class="tri-audio-menu__device" aria-haspopup="menu" aria-expanded={submenu} onClick={()=>setSubmenu(!submenu)}>
      <span><strong>{input?'Dispositivo de entrada':'Dispositivo de saída'}</strong><small>{current}</small></span><Icon name="ChevronSmallRight" size={20}/>
    </button>
    <div class="tri-audio-menu__separator"/>
    <label class="tri-audio-menu__volume">{input?'Volume de entrada':'Volume de saída'}
      <input class="tri-slider" aria-label={input?'Volume de entrada':'Volume de saída'} type="range" min={0} max={max} value={value}
        style={{'--tri-fill':`${value/max*100}%`}} onInput={e=>set(input?'inputVolume':'outputVolume',+e.currentTarget.value)}/>
    </label>
    <div class="tri-audio-menu__separator"/>
    <button class="tri-audio-menu__settings" onClick={()=>{close();dispatchEvent(new Event('tri-open-settings'));}}><Icon name="Settings" size={20}/><span>Configurações de voz</span></button>
    {error&&<div role="alert">{error}</div>}
    {submenu&&<div class={`tri-audio-menu__submenu ${pos.left+446>innerWidth?'is-left':''}`} style={{maxHeight:Math.max(120,innerHeight-pos.top-24)}} role="menu" aria-label={input?'Dispositivos de entrada':'Dispositivos de saída'}>
      {choices.map(c=><button key={c.id||'default'} role="menuitemradio" aria-checked={selected===c.id} onClick={()=>{set(input?'inputDevice':'outputDevice',c.id);close();}}>
        <Icon name={input?'Microphone':'Headphones'} size={20}/><span>{c.name}</span><i class={selected===c.id?'is-selected':''}/>
      </button>)}
    </div>}
  </div>;
}
