import { closeSync } from 'node:fs';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { descriptorPath, openPrivate } from '../scoped-files';
import { MAX_ATTACHMENT_BYTES, isSnapshotId, safeAttachmentName } from './store';

/** Keep Durable's image/text handling. Give it a pinned upload, not a checked-then-reopened host pathname. */
export function createUploadReadTool(directory: string): ReturnType<typeof createReadTool> {
  const read = createReadTool();
  return {...read, description:'Read text or an image from the exact uploaded file path in the conversation.',
    async execute(args, api, context) {
      const prefix = `${directory}/`, [id, name, ...extra] = args.path.slice(prefix.length).split('/');
      const failure = {isError:true, output:[{type:'text' as const, text:'Only regular uploaded files can be read.'}]};
      if (!args.path.startsWith(prefix) || extra.length || !isSnapshotId(id) || !name || safeAttachmentName(name) !== name) return failure;
      let fd;
      try { fd = openPrivate(directory, [id, name], MAX_ATTACHMENT_BYTES).fd; } catch { return failure; }
      try { return await read.execute({...args, path:descriptorPath(fd)}, api, context); }
      finally { closeSync(fd); }
    },
  };
}
