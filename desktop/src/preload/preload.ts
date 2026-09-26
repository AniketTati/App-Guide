import { contextBridge, ipcRenderer } from 'electron'

/** The page's only door out: named calls with string arguments, and a signal
 *  when something changed between looks. */
contextBridge.exposeInMainWorld('appguide', {
  call: (method: string, ...args: string[]): Promise<unknown> => ipcRenderer.invoke('api', method, args),
  onChanged: (listener: (projectId: string, workIds: string[]) => void): (() => void) => {
    const handler = (_e: unknown, id: string, workIds: unknown): void => listener(id, Array.isArray(workIds) ? workIds.filter((w): w is string => typeof w === 'string') : [])
    ipcRenderer.on('changed', handler)
    return () => { ipcRenderer.off('changed', handler) }
  },
})
