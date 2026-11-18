// MODULE: brain-cutover-lifecycle.ts - Cancel uncommitted consent when its window is replaced
import type {BrowserWindow} from 'electron'
export function bindBrainCutoverWindow(window:Pick<BrowserWindow,'on'|'webContents'>,cancel:()=>void):void {
 window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)cancel()})
 window.webContents.on('render-process-gone',()=>cancel())
 window.webContents.on('destroyed',()=>cancel())
 window.on('closed',()=>cancel())
}
