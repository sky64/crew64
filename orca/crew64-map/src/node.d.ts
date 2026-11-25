// The few Node APIs the worker uses. The plugin typings carry no @types/node and the plugin has
// no dependencies, so only what src/sources.ts and src/main.ts call is declared here.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { cwd?: string; timeout?: number; maxBuffer?: number; encoding: 'utf8'; windowsHide?: boolean },
    callback: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void
  ): unknown
}
declare module 'node:fs' {
  export type FSWatcher = { close(): void; on(event: 'error', listener: (error: Error) => void): FSWatcher }
  export function watch(path: string, listener: (event: string, filename: string | null) => void): FSWatcher
  // Used by the tests.
  export function readFileSync(path: string | URL, encoding: 'utf8'): string
}
declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function mkdtemp(prefix: string): Promise<string>
  export function writeFile(path: string, data: string): Promise<void>
  export function appendFile(path: string, data: string): Promise<void>
  export function mkdir(path: string, options?: { recursive: boolean }): Promise<string | undefined>
  export function stat(path: string): Promise<{ mtimeMs: number; isFile(): boolean }>
  export function lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  export function realpath(path: string): Promise<string>
  export function symlink(target: string, path: string): Promise<void>
  export function rm(path: string, options: { recursive: boolean }): Promise<void>
}
declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string
  export function resolve(...parts: string[]): string
  export function isAbsolute(path: string): boolean
}
declare const process: { env: Record<string, string | undefined> }
