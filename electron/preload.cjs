const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('programmeDesktop', {
  info: () => ipcRenderer.invoke('programme:info'),
});
