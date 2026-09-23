import type { Track } from './protocol';

export interface LocalTrack extends Track { handle: FileSystemFileHandle }
const audioExtensions = new Set(['mp3', 'm4a', 'aac', 'wav', 'wave', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'webm', 'mp4']);

export async function scanFolder(directory: FileSystemDirectoryHandle, signal: AbortSignal, onProgress: (count: number) => void): Promise<{ tracks: LocalTrack[]; skipped: number }> {
  const tracks: LocalTrack[] = [];
  let skipped = 0;
  async function visit(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of dir.entries()) {
      signal.throwIfAborted();
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await visit(handle, path);
      } else {
        const extension = name.split('.').pop()?.toLowerCase() ?? '';
        if (!audioExtensions.has(extension)) { skipped++; continue; }
        try {
          const file = await handle.getFile();
          tracks.push({ id: path, path, name, format: extension.toUpperCase(), size: file.size, handle });
          if (tracks.length % 20 === 0) onProgress(tracks.length);
        } catch { skipped++; }
      }
    }
  }
  await visit(directory, '');
  signal.throwIfAborted();
  tracks.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  return { tracks, skipped };
}

export function publicTrack({ handle: _handle, ...track }: LocalTrack): Track { return track; }
