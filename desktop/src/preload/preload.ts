import { contextBridge, ipcRenderer } from 'electron'

/** The page's only door out: named calls with string arguments, and a signal
 *  when something changed between looks. */
contextBridge.exposeInMainWorld('appguide', {
  call: (method: string, ...args: string[]): Promise<unknown> => ipcRenderer.invoke('api', method, args),
  onChanged: (listener: (projectId: string, moved: [string, string][]) => void): (() => void) => {
    const handler = (_e: unknown, id: string, moved: unknown): void => listener(id, Array.isArray(moved)
      ? moved.filter((m): m is [string, string] => Array.isArray(m) && m.length === 2 && typeof m[0] === 'string' && typeof m[1] === 'string')
      : [])
    ipcRenderer.on('changed', handler)
    return () => { ipcRenderer.off('changed', handler) }
  },
})
