import { contextBridge, ipcRenderer } from 'electron'

/** The page's only door out: named calls with string arguments, and a signal
 *  when something changed between looks. */
contextBridge.exposeInMainWorld('appguide', {
  call: (method: string, ...args: string[]): Promise<unknown> => ipcRenderer.invoke('api', method, args),
  onChanged: (listener: (projectId: string) => void): (() => void) => {
    const handler = (_e: unknown, id: string): void => listener(id)
    ipcRenderer.on('changed', handler)
    return () => { ipcRenderer.off('changed', handler) }
  },
})
