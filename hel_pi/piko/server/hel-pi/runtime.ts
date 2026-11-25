import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { isSnapshotId } from "../attachments/store";
import { ConversationStores } from "../chat/stores";
import { readApplicationSettings } from "../config";
import { openRuntime } from "../runtime/bootstrap";
import { DurableChatSession } from "../runtime/conversation-session";
import { loadWorkspaceModels, requireAvailableModel } from "../runtime/model-config";
import { settingsSnapshot } from "../runtime/settings";
import { ModelSettingsStore } from "../settings/configuration";
import type { RuntimeSelection } from "../../shared/runtime";
import type { WorkspacePaths } from "../workspace";

export async function openChat(paths: WorkspacePaths) {
  const config = await loadWorkspaceModels({ home: paths.home, settings: readApplicationSettings(paths.home), env: {} });
  const registry = createRegistry();
  const directory = join(paths.state, 'attachments') + '/';
  const read = createReadTool();
  const readUpload: typeof read = {
    ...read,
    description: 'Read text or an image from the exact uploaded file path in the conversation. No other files are available.',
    async execute(args, api, context) {
      const [id, name, ...rest] = args.path.slice(directory.length).split('/');
      if (!args.path.startsWith(directory) || !isSnapshotId(id) || !name || rest.length ||
          await realpath(args.path).catch(() => '') !== args.path) {
        return { isError: true, output: [{ type: 'text', text: 'Only uploaded files can be read.' }] };
      }
      return read.execute(args, api, context);
    },
  };
  registry.install(defineExtension({ name: 'hel-pi-uploads', tools: [readUpload] }));
  const { harness, storage } = await openRuntime(paths, config, registry);
  try {
    const root = (await harness.conversation(ROOT_CONVERSATION_ID, ctx))!;
    await root.configure({ instructions: 'You are Hel-Pi, a personal chat assistant. Answer in the language of the user. Use read for files attached to this conversation.' }, ctx);
    const session = new DurableChatSession(paths, harness, storage, root, config, false);
    await session.init();
    harness.resume();
    const chats = new ConversationStores({ createSession: async () => session });
    const modelSettings = new ModelSettingsStore(paths.home);
    return {
      chats,
      isModelReady: () => session.modelReady(),
      settings: async () => settingsSnapshot(await root.agent(ctx), config, await modelSettings.snapshot()),
      async configure(selection: RuntimeSelection) {
        if (!('provider' in selection)) throw new Error('Choose a model first.');
        const model = await requireAvailableModel(config.models, selection);
        const main = { ...selection, thinking: clampThinkingLevel(model, selection.thinking ?? 'off') };
        const previous = await modelSettings.snapshot();
        await modelSettings.save({ baseRevision: previous.revision, mainModel: main, backgroundModel: null, backgroundThinking: null });
        config.main = main;
        if (!session.isStreaming) await session.syncConfiguredMain();
      },
      async close() {
        await chats.close();
        await session.dispose();
        await harness.close(ctx);
      },
    };
  } catch (error) {
    await harness.close(ctx);
    throw error;
  }
}
