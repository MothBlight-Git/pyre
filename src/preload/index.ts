import { contextBridge, ipcRenderer } from 'electron';
import type { PyreBridge } from '../shared/types';

const on = <T extends unknown[]>(channel: string) => (cb: (...args: T) => void) => {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const bridge: PyreBridge = {
  list: () => ipcRenderer.invoke('notes:list'),
  add: (input) => ipcRenderer.invoke('notes:add', input),
  update: (id, patch) => ipcRenderer.invoke('notes:update', id, patch),
  move: (id, col, row) => ipcRenderer.invoke('notes:move', id, col, row),
  release: (id) => ipcRenderer.invoke('notes:release', id),
  snuff: (id) => ipcRenderer.invoke('notes:snuff', id),
  restore: (id) => ipcRenderer.invoke('notes:restore', id),
  bank: (id, until) => ipcRenderer.invoke('notes:bank', id, until),
  unbank: (id) => ipcRenderer.invoke('notes:unbank', id),
  remove: (id) => ipcRenderer.invoke('notes:remove', id),
  correct: (c) => ipcRenderer.invoke('notes:correct', c),
  messages: () => ipcRenderer.invoke('msg:list'),
  say: (text) => ipcRenderer.invoke('msg:say', text),
  markMessagesRead: () => ipcRenderer.invoke('msg:markRead'),
  clearMessages: () => ipcRenderer.invoke('msg:clear'),
  onMessages: on('msg:changed'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resizeRail: (w) => ipcRenderer.invoke('rail:resize', w),
  info: () => ipcRenderer.invoke('app:info'),
  revealData: () => ipcRenderer.invoke('app:reveal'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onChange: on('notes:changed'),
  onWriteError: on('notes:writeError'),
  onWriteOk: on('notes:writeOk'),
  onSettings: on('settings:changed'),
  onFocusComposer: on('app:focusComposer'),
  onOpenSettings: on('app:openSettings'),
};

contextBridge.exposeInMainWorld('pyre', bridge);
