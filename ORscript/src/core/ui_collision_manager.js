// SPDX-License-Identifier: GPL-3.0-or-later
// Respectful host-UI collision handling. Runs in the isolated extension world.
(() => {
  "use strict";
  if (globalThis.ORUICollisionManager) return;
  const STATES=Object.freeze({VISIBLE:"VISIBLE",REPOSITIONING:"REPOSITIONING",TEMPORARILY_HIDDEN:"TEMPORARILY_HIDDEN",RESTORING:"RESTORING"});
  const PROVIDER_SELECTORS={
    chatgpt:['[data-testid*="modal"]','[data-testid*="popover"]','[role="dialog"]'],
    deepseek:['.ds-modal','[class*="modal"]','[role="dialog"]'],
    gemini:['mat-dialog-container','.cdk-overlay-pane','[role="dialog"]'],
    claude:['[data-radix-popper-content-wrapper]','[role="dialog"]'],
    qwen:['.ant-modal','.ant-drawer','.ant-dropdown','[role="dialog"]'],
    kimi:['.n-modal','.n-drawer','.v-binder-follower-content','[role="dialog"]']
  };
  const FALLBACK='[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-state="open"],[class*="modal" i],[class*="popover" i],[class*="drawer" i],[class*="overlay" i]';
  const visible=(el)=>{if(!el||el.closest('#rs-root'))return false;const r=el.getBoundingClientRect();if(r.width<8||r.height<8)return false;const s=getComputedStyle(el);return s.display!=="none"&&s.visibility!=="hidden"&&+s.opacity!==0;};
  const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  class CollisionManager{
    constructor(){this.state=STATES.VISIBLE;this.root=null;this.provider="";this.observers=[];this.timer=0;this.raf=0;this.lastUrl=location.href;this.bound=()=>this.schedule();}
    initialize({root,provider}={}){if(this.root===root&&this.observers.length)return this;this.destroy();this.root=root||document.getElementById('rs-root');this.provider=String(provider||'').toLowerCase();if(!this.root)return this;
      const body=document.body||document.documentElement;const direct=new MutationObserver(this.bound);direct.observe(body,{childList:true});this.observers.push(direct);
      const composer=this.root.parentElement&&this.root.parentElement!==document.documentElement?this.root.parentElement:null;if(composer){const scoped=new MutationObserver(this.bound);scoped.observe(composer,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','aria-expanded','data-state']});this.observers.push(scoped);}
      addEventListener('resize',this.bound,{passive:true});addEventListener('popstate',this.bound);document.addEventListener('visibilitychange',this.bound);this.timer=setInterval(()=>{if(location.href!==this.lastUrl){this.lastUrl=location.href;this.schedule();}else this.evaluate();},1000);this.evaluate();return this;}
    candidates(){const selectors=[...(PROVIDER_SELECTORS[this.provider]||[]),FALLBACK];const out=[],seen=new Set();for(const sel of selectors){try{for(const el of document.querySelectorAll(sel)){if(!seen.has(el)&&visible(el)){seen.add(el);out.push(el);}}}catch{}}return out;}
    setState(next){if(next===this.state)return;this.state=next;if(this.root)this.root.dataset.rsCollisionState=next;dispatchEvent(new CustomEvent('orscript:collision-state',{detail:{state:next,provider:this.provider}}));}
    schedule(){if(this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=0;this.evaluate();});}
    evaluate(){if(!this.root||!this.root.isConnected)return;const rr=this.root.getBoundingClientRect(),viewport=innerWidth*innerHeight;let hide=false,move=false;for(const el of this.candidates()){const r=el.getBoundingClientRect(),area=r.width*r.height;const modal=el.matches('[role="dialog"],[aria-modal="true"]')||area>viewport*.32;if(modal&&(intersects(r,rr)||area>viewport*.55)){hide=true;break;}if(intersects(r,rr))move=true;}
      if(hide){this.setState(STATES.TEMPORARILY_HIDDEN);this.root.style.setProperty('visibility','hidden','important');this.root.style.setProperty('pointer-events','none','important');return;}
      if(this.state===STATES.TEMPORARILY_HIDDEN)this.setState(STATES.RESTORING);this.root.style.removeProperty('visibility');this.root.style.removeProperty('pointer-events');if(move){this.setState(STATES.REPOSITIONING);this.root.style.setProperty('--rs-collision-offset','72px');}else{this.root.style.removeProperty('--rs-collision-offset');this.setState(STATES.VISIBLE);}}
    destroy(){for(const o of this.observers)o.disconnect();this.observers=[];clearInterval(this.timer);this.timer=0;if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;removeEventListener('resize',this.bound);removeEventListener('popstate',this.bound);document.removeEventListener('visibilitychange',this.bound);if(this.root){this.root.style.removeProperty('visibility');this.root.style.removeProperty('pointer-events');this.root.style.removeProperty('--rs-collision-offset');}this.root=null;this.state=STATES.VISIBLE;}
  }
  globalThis.ORUICollisionManager={STATES,instance:new CollisionManager(),CollisionManager};
})();
