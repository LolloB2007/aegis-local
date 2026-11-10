// Sandboxed Electron preload exposes only overlay UI operations, never tools.
const {contextBridge,ipcRenderer,clipboard}=require('electron');
const EVENTS=new Set(['recording-started','recording-stopped','transcription-ready','close-overlay']);
contextBridge.exposeInMainWorld('aegisOverlay',Object.freeze({
  on(event,listener){
    if(!EVENTS.has(event)||typeof listener!=='function')return;
    ipcRenderer.on(event,(_event,value)=>listener(value));
  },
  close(){ipcRenderer.send('overlay-close');},
  stop(){ipcRenderer.send('stop-recording');},
  copy(text){clipboard.writeText(String(text||'').slice(0,4000));}
}));
